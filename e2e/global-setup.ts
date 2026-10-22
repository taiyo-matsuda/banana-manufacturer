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

// テスト農園 A に前回までの E2E が残した圃場・株を消す（auth.setup.ts が A のセッションで呼ぶ）。
// 行を消さずに走らせ続けると /fields の一覧が数百行に膨れ、登録（refresh を伴う Server Action）の応答が
// 数百 KB・数秒になって flaky の一因になった。
// 消すのは名前が `E2E` で始まる圃場と、その圃場の株だけ（手動確認用の圃場は残す）。
// 観測・イベント（leaves.spec.ts が作る）は追記のみで削除ポリシーがなく、stems への FK も cascade ではない。
// それらを持つ茎・株・圃場は消さずに残す（1 回の実行で数件。溜まりすぎたら別の方法を考える。
// 残した圃場の数はログに出す）。
export async function cleanupTestFarmA(supabase: SupabaseClient): Promise<number> {
  const { data: fields, error: selectError } = await supabase
    .from("fields")
    .select("id")
    .like("name", "E2E%");
  if (selectError) throw new Error(`E2E の掃除: 圃場を取得できません: ${selectError.message}`);
  const ids = (fields ?? []).map((f) => f.id as string);
  let kept = 0;

  // URL 長の上限を避けて 100 件ずつ。FK は cascade でないので stems → mats → fields の順に消す
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { data: mats, error: matsError } = await supabase.from("mats").select("id, field_id").in("field_id", chunk);
    if (matsError) throw new Error(`E2E の掃除: 株を取得できません: ${matsError.message}`);
    const matIds = (mats ?? []).map((m) => m.id as string);
    // 観測・イベントを持つ茎（消せない）とその株・圃場
    const keptStems = new Set<string>();
    const keptMats = new Set<string>();
    const keptFields = new Set<string>();
    for (let j = 0; j < matIds.length; j += 100) {
      const matChunk = matIds.slice(j, j + 100);
      const { data: stems, error: stemsError } = await supabase
        .from("stems")
        .select("id, mat_id")
        .in("mat_id", matChunk);
      if (stemsError) throw new Error(`E2E の掃除: 茎を取得できません: ${stemsError.message}`);
      const stemIds = (stems ?? []).map((s) => s.id as string);
      if (stemIds.length > 0) {
        const [{ data: obs, error: obsError }, { data: evs, error: evError }] = await Promise.all([
          supabase.from("observations").select("stem_id").in("stem_id", stemIds),
          supabase.from("events").select("target_id").eq("target_type", "stem").in("target_id", stemIds),
        ]);
        if (obsError) throw new Error(`E2E の掃除: 観測を取得できません: ${obsError.message}`);
        if (evError) throw new Error(`E2E の掃除: イベントを取得できません: ${evError.message}`);
        for (const o of obs ?? []) keptStems.add(o.stem_id as string);
        for (const e of evs ?? []) keptStems.add(e.target_id as string);
      }
      for (const s of stems ?? []) {
        if (keptStems.has(s.id as string)) keptMats.add(s.mat_id as string);
      }
      const deletable = stemIds.filter((id) => !keptStems.has(id));
      if (deletable.length > 0) {
        await withRetry("茎を消せません", () => supabase.from("stems").delete().in("id", deletable));
      }
    }
    for (const m of mats ?? []) {
      if (keptMats.has(m.id as string)) keptFields.add(m.field_id as string);
    }
    const deletableMats = matIds.filter((id) => !keptMats.has(id));
    if (deletableMats.length > 0) {
      await withRetry("株を消せません", () => supabase.from("mats").delete().in("id", deletableMats));
    }
    const deletableFields = chunk.filter((id) => !keptFields.has(id));
    if (deletableFields.length > 0) {
      await withRetry("圃場を消せません", () => supabase.from("fields").delete().in("id", deletableFields));
    }
    kept += keptFields.size;
  }
  if (kept > 0) {
    console.log(`E2E の掃除: 観測・イベントを持つ茎があるため、圃場 ${kept} 件は残した（追記のみのため消せない）`);
  }
  return ids.length - kept;
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
