import { mkdirSync, writeFileSync } from "node:fs";
import { test as setup, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { cleanupTestFarmA } from "./global-setup";
import {
  accountA,
  accountB,
  AUTH_DIR,
  AUTH_STATE_A,
  AUTH_STATE_B,
  env,
  login,
  SESSION_A,
  SESSION_B,
  supabaseAsA,
} from "./helpers";

// setup プロジェクト: テスト農園 A / B に 1 回ずつログインし、Cookie（storageState）と
// supabase-js 用のセッション（access_token / refresh_token）を e2e/.auth/ に保存する。
// iphone / desktop の各テストはこれを使ってログイン済みの状態から始める（テストごとにログインしない）。
// Supabase Auth のサインインは IP ごとにレート制限があり、テストごとにログインすると 1 回の実行で
// 30 回を超えて「メールアドレスまたはパスワードが正しくありません」になる。
// 1 回の実行でのログイン: ここで 4 回（UI A / B、API A / B）＋ auth.spec のログイン画面の検証 2 件 × 2 プロジェクト。
// 最後に、前回までの E2E が残した圃場・株を A のセッションで消す（このファイルのテストは上から順に走る）。

setup.beforeAll(() => {
  mkdirSync(AUTH_DIR, { recursive: true });
});

setup("テスト農園 A でログインして状態を保存する", async ({ page }) => {
  const a = accountA();
  await login(page, a.email, a.password);
  await expect(page.getByTestId("organization-name")).toHaveText("テスト農園A");
  await page.context().storageState({ path: AUTH_STATE_A });
  await saveApiSession(a.email, a.password, SESSION_A);
});

setup("テスト農園 B でログインして状態を保存する", async ({ page }) => {
  const b = accountB();
  await login(page, b.email, b.password);
  await expect(page.getByTestId("organization-name")).toHaveText("テスト農園B");
  await page.context().storageState({ path: AUTH_STATE_B });
  await saveApiSession(b.email, b.password, SESSION_B);
});

setup("テスト農園 A の E2E 圃場・株を掃除する", async () => {
  const n = await cleanupTestFarmA(await supabaseAsA());
  console.log(`E2E の掃除: テスト農園 A の E2E 圃場 ${n} 件（とその株）を削除`);
});

// DB を直接読む／書くテスト用に supabase-js のセッションを保存する（helpers の supabaseAs* が読む）
async function saveApiSession(email: string, password: string, path: string) {
  const supabase = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`${email} で API サインインできません: ${error?.message}`);
  writeFileSync(
    path,
    JSON.stringify({ access_token: data.session.access_token, refresh_token: data.session.refresh_token }),
  );
}
