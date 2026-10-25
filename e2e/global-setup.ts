import { spawnSync } from "node:child_process";
import type { SupabaseClient } from "@supabase/supabase-js";

// Playwright の globalSetup（全プロジェクトの前に 1 回）。
// ログインとテストデータの掃除は setup プロジェクト（auth.setup.ts）が行う。ここではログインが要らない準備だけ。
export default async function globalSetup() {
  await waitForEphemeralPorts();
}

// Windows の TCP 動的ポートは既定で 16,384 個（IPv4 / IPv6 で別）、TIME_WAIT は 120 秒続く。
// E2E 1 回でブラウザ → 開発サーバー（:3000）の接続を数千使うので、続けて走らせるとポートが枯渇し、
// `fetch failed` / `ERR_ADDRESS_IN_USE` / Server Action の応答が途中で止まる、という形でランダムに落ちる。
// 数えるのは :3000 向けだけ（この PC は常駐アプリの TIME_WAIT が常に 5,000 前後あり、合計では判定できない）。
// 多すぎるときは解放されるまで待ってから始める（原因不明の flaky にせず、理由を出して待つ）。
const TIME_WAIT_LIMIT = 6_000;
const TIME_WAIT_WAIT_MAX_MS = 180_000;

async function waitForEphemeralPorts() {
  if (process.platform !== "win32") return;
  const started = Date.now();
  for (;;) {
    const n = countTimeWait();
    if (n === null || n < TIME_WAIT_LIMIT) return;
    const elapsed = Date.now() - started;
    if (elapsed >= TIME_WAIT_WAIT_MAX_MS) {
      console.warn(
        `E2E: 開発サーバー（:3000）向けの TIME_WAIT ソケットが ${n} 個あり、${TIME_WAIT_WAIT_MAX_MS / 1000} 秒待っても減らないので、そのまま始める（動的ポートの枯渇で落ちることがある。architecture.md 7 章を参照）`,
      );
      return;
    }
    console.log(`E2E: 開発サーバー（:3000）向けの TIME_WAIT ソケットが ${n} 個（上限 ${TIME_WAIT_LIMIT}）。ポートの解放を待つ…`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

// netstat の行: プロトコル, ローカル, リモート, 状態, PID。リモートが 127.0.0.1:3000 / [::1]:3000 の TIME_WAIT を数える
const DEV_SERVER_TIME_WAIT = /^\s*TCP\s+\S+\s+(127\.0\.0\.1|\[::1\]):3000\s+TIME_WAIT/;

function countTimeWait(): number | null {
  // `-p tcp` は IPv4 だけなので付けない（IPv6 の [::1] も数える）
  const r = spawnSync("netstat", ["-ano"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.split("\n").filter((l) => DEV_SERVER_TIME_WAIT.test(l)).length;
}

// テスト農園 A に前回までの E2E が残した圃場・株・茎と、その観測・イベント・写真を消す（auth.setup.ts が A のセッションで呼ぶ）。
// 行を消さずに走らせ続けると /fields の一覧が数百行に膨れ、登録（refresh を伴う Server Action）の応答が
// 数百 KB・数秒になって flaky の一因になった。
// 観測・イベントは追記のみ（RLS に delete ポリシーがなく、stems への FK も cascade ではない）ため、
// アプリの権限では消せない。E2E 専用組織の掃除だけは例外として、組織名で制限した security definer の
// DB 関数 `e2e_cleanup_fields`（0006）で行う。消すのは名前が `E2E` で始まる圃場に紐づくものだけ
// （手動確認用の圃場は残す）。戻り値は削除した圃場の数。
// 写真の実体（Storage のオブジェクト）は DB 関数では消えないので、RPC の前に `photos.storage_path` を集めて
// Storage から消す（0007 の delete ポリシーは E2E 専用組織だけに許可）。
export async function cleanupTestFarmA(supabase: SupabaseClient): Promise<number> {
  await removeE2EPhotoObjects(supabase);
  let deleted = 0;
  await withRetry("E2E 圃場を消せません", async () => {
    const { data, error } = await supabase.rpc("e2e_cleanup_fields", { prefix: "E2E" });
    if (!error) deleted = (data as number | null) ?? 0;
    return { error };
  });
  return deleted;
}

// E2E 圃場（名前が E2E で始まる）の株・茎に紐づく写真の Storage オブジェクトを消す。
// photos → stems → mats → fields を辿る（photos.target_id には FK がないので、茎の id を集めてから絞る）
async function removeE2EPhotoObjects(supabase: SupabaseClient) {
  const { data: fields, error: fErr } = await supabase.from("fields").select("id").like("name", "E2E%");
  if (fErr) throw new Error(`E2E の掃除: 圃場を取得できません: ${fErr.message}`);
  if (!fields || fields.length === 0) return;
  const fieldIds = fields.map((f) => f.id as string);
  const matIds = await selectIdsIn(supabase, "mats", "id", "field_id", fieldIds, "株");
  if (matIds.length === 0) return;
  const stemIds = await selectIdsIn(supabase, "stems", "id", "mat_id", matIds, "茎");
  const targetIds = [...matIds, ...stemIds, ...fieldIds];
  const paths = await selectIdsIn(supabase, "photos", "storage_path", "target_id", targetIds, "写真");
  if (paths.length === 0) return;
  for (const chunk of chunks(paths, IN_CHUNK)) {
    await withRetry("写真の実体を消せません", async () => {
      const { error } = await supabase.storage.from("photos").remove(chunk);
      return { error };
    });
  }
  console.log(`E2E の掃除: Storage の写真 ${paths.length} 件を削除`);
}

// .in() に渡す id が多いと GET の URL が長くなりすぎて fetch failed になる（約 400 個で失敗した）ので、100 個ずつに分ける
const IN_CHUNK = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function selectIdsIn(
  supabase: SupabaseClient,
  table: string,
  column: string,
  filterColumn: string,
  values: readonly string[],
  label: string,
): Promise<string[]> {
  const result: string[] = [];
  for (const chunk of chunks(values, IN_CHUNK)) {
    const { data, error } = await supabase.from(table).select(column).in(filterColumn, chunk);
    if (error) throw new Error(`E2E の掃除: ${label}を取得できません: ${error.message}`);
    for (const row of (data ?? []) as unknown as Record<string, string>[]) result.push(row[column]);
  }
  return result;
}

// ポート枯渇などの一時的な `fetch failed` は数秒待って 1 回やり直す（削除は冪等なので安全）
async function withRetry(what: string, run: () => PromiseLike<{ error: { message: string } | null }>) {
  for (let attempt = 1; ; attempt++) {
    const { error } = await run();
    if (!error) return;
    if (attempt >= 2 || !/fetch failed/i.test(error.message)) throw new Error(`E2E の掃除: ${what}: ${error.message}`);
    console.warn(`E2E の掃除: ${what}（${error.message}）。5 秒待ってやり直す`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
