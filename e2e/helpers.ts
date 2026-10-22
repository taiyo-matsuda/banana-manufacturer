import { type BrowserContext, test as base, expect, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// 環境変数は playwright.config.ts が .env.local から読み込む
export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が設定されていません（.env.local を確認）`);
  return value;
}

export const accountA = () => ({
  email: env("E2E_EMAIL"),
  password: env("E2E_PASSWORD"),
});

export const accountB = () => ({
  email: env("E2E_B_EMAIL"),
  password: env("E2E_B_PASSWORD"),
});

// ログイン画面でフォームを送信する。遷移の検証は呼び出し側で行う
export async function submitLogin(page: Page, email: string, password: string) {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
}

// ログインしてホームに遷移するところまで。
// 遷移しなかったときは、画面のエラー文言（レート制限など原因の手がかり）を含めて失敗させる
export async function login(page: Page, email: string, password: string) {
  await submitLogin(page, email, password);
  try {
    await expect(page).toHaveURL("/");
  } catch (e) {
    const shown = await page
      .getByTestId("login-error")
      .textContent({ timeout: 1_000 })
      .catch(() => null);
    const detail = shown ? `画面のエラー: ${shown}` : "画面にエラー表示なし";
    throw new Error(
      `ログインしてもホームに遷移しませんでした（${detail}。Supabase Auth のレート制限の可能性もあります）\n${(e as Error).message}`,
    );
  }
}

// テスト農園 A としてサインインした Supabase クライアント（DB の直接確認・テストデータの作成に使う）。
// Supabase Auth のサインインはレート制限があるため、ワーカー内で 1 回だけサインインして使い回す
let supabaseAPromise: Promise<SupabaseClient> | null = null;
export function supabaseAsA(): Promise<SupabaseClient> {
  if (!supabaseAPromise) {
    supabaseAPromise = (async () => {
      const a = accountA();
      const supabase = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await supabase.auth.signInWithPassword({ email: a.email, password: a.password });
      if (error) throw new Error(`テスト農園 A でサインインできません: ${error.message}`);
      return supabase;
    })();
    supabaseAPromise.catch(() => {
      supabaseAPromise = null;
    });
  }
  return supabaseAPromise;
}

type AuthFixtures = {
  // テスト農園 A で UI ログインしたときの Cookie 等。ワーカーで 1 回だけログインして全テストで共有する
  authStateA: Awaited<ReturnType<BrowserContext["storageState"]>>;
};

// テスト農園 A でログイン済みの状態から始まる test。
// 未ログインの挙動を確かめるテストは、describe 内で `test.use({ storageState: { cookies: [], origins: [] } })` を使う
export const test = base.extend<object, AuthFixtures>({
  authStateA: [
    async ({ browser }, provide, workerInfo) => {
      const a = accountA();
      const context = await browser.newContext({
        baseURL: workerInfo.project.use.baseURL,
      });
      const page = await context.newPage();
      await login(page, a.email, a.password);
      const state = await context.storageState();
      await context.close();
      await provide(state);
    },
    { scope: "worker" },
  ],
  storageState: async ({ authStateA }, provide) => {
    await provide(authStateA);
  },
});

export { expect };

// 未ログイン状態（describe の中で test.use に渡す）
export const noSession = { cookies: [], origins: [] };

// 圃場記号（英数字 1〜4 文字、組織内で unique）をテストごとに一意にする。
// 0005 のバックフィルが付けた `X001…` と衝突しないよう、X は使わない。
export function randomFieldCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWYZ0123456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
