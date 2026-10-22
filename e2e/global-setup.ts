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
export async function cleanupTestFarmA(supabase: SupabaseClient): Promise<number> {
  let deleted = 0;
  await withRetry("E2E 圃場を消せません", async () => {
    const { data, error } = await supabase.rpc("e2e_cleanup_fields", { prefix: "E2E" });
    if (!error) deleted = (data as number | null) ?? 0;
    return { error };
  });
  return deleted;
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
