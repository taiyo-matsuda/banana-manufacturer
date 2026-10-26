import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
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

// ログイン状態の保存先。auth.setup.ts（setup プロジェクト）が実行のはじめに 1 回だけ作る。
// iphone / desktop プロジェクトの既定の storageState は A（playwright.config.ts）。
// B で見たいテストは describe 内で `test.use({ storageState: AUTH_STATE_B })`、
// 未ログインを確かめるテストは `test.use({ storageState: noSession })` を使う。
export const AUTH_DIR = path.resolve(__dirname, ".auth");
export const AUTH_STATE_A = path.join(AUTH_DIR, "a.json");
export const AUTH_STATE_B = path.join(AUTH_DIR, "b.json");
export const SESSION_A = path.join(AUTH_DIR, "a-session.json");
export const SESSION_B = path.join(AUTH_DIR, "b-session.json");

// 未ログイン状態（describe の中で test.use に渡す）
export const noSession = { cookies: [], origins: [] };

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

// テスト農園 A / B としてサインインした supabase-js クライアント（DB の直接確認・テストデータの作成に使う）。
// サインインはしない。auth.setup.ts が保存したセッション（access_token / refresh_token）を読んで使う。
// 1 回の実行は数分で終わるので、access_token（1 時間）が切れることは想定しない。
const clients = new Map<string, Promise<SupabaseClient>>();
function supabaseFromSavedSession(sessionPath: string, label: string): Promise<SupabaseClient> {
  let p = clients.get(sessionPath);
  if (!p) {
    p = (async () => {
      let saved: { access_token: string; refresh_token: string };
      try {
        saved = JSON.parse(readFileSync(sessionPath, "utf8"));
      } catch {
        throw new Error(
          `${label} のセッションがありません（${sessionPath}）。setup プロジェクト（e2e/auth.setup.ts）が先に走る必要があります`,
        );
      }
      const supabase = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await supabase.auth.setSession(saved);
      if (error) throw new Error(`${label} の保存セッションを使えません: ${error.message}`);
      return supabase;
    })();
    clients.set(sessionPath, p);
    p.catch(() => clients.delete(sessionPath));
  }
  return p;
}
export const supabaseAsA = () => supabaseFromSavedSession(SESSION_A, "テスト農園 A");
export const supabaseAsB = () => supabaseFromSavedSession(SESSION_B, "テスト農園 B");

// 各 spec は @playwright/test ではなくここから test / expect を import する（ログイン方式を 1 か所で変えられるように）
export { test, expect };

// Server Action（登録・確定）の結果を待つときのタイムアウト。
// 1 回の登録は proxy の getUser → Action の getUser と insert → refresh() の再描画（getUser と select）と
// Supabase への往復 5 回が直列に走り、その応答（RSC ペイロード）を開発サーバーが流し終えるまで待つ必要がある。
// 他のテストと並行して走ると 5 秒（既定）では足りないことがあった（fields 3b の flaky）。
export const ACTION_TIMEOUT = 15_000;

// 1-9: 記録は端末の outbox に積まれてから同期ワーカーが送る（オンラインでも同じ経路）。
// 画面は outbox の購読で即座に反映されるが、DB を直接確かめる・再読み込みする前には、ヘッダの未同期件数が 0 に
// なる（= サーバーに届いた）のを待つ。呼ぶのは「画面に反映された」ことを確かめた後（その前だと 0 → 1 → 0 の最初の 0 を拾う）
export async function waitForSynced(page: Page) {
  await expect(page.getByTestId("sync-pending-count")).toHaveText("0", { timeout: ACTION_TIMEOUT });
}

// 圃場記号（英数字 1〜4 文字、組織内で unique）をテストごとに一意にする。
// 0005 のバックフィルが付けた `X001…` と衝突しないよう、X は使わない。
// 4 桁の乱数では 1 回の実行で数 % の確率で既存の E2E 圃場と衝突した（2-9 の後の fields 3 の失敗）ので、
// 1 文字目 = ワーカーの parallelIndex（同時に走るワーカー同士で重ならない）、
// 残り 3 文字 = ワーカーの起動時刻（0.1 秒単位）から始める連番にする。
// 同じ parallelIndex で後から起動したワーカーは、前のワーカーが使い切った番号より後から始まる
// （記号の生成は 0.1 秒に 1 回より遅い）。連番は約 1 時間で一周するが、1 回の実行は十数分で、
// 前の実行の E2E 圃場は setup の掃除で消える。
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWYZ0123456789";
const CODE_SPACE = CODE_CHARS.length ** 3;
let codeCounter = Math.floor(Date.now() / 100) % CODE_SPACE;

export function randomFieldCode(): string {
  let index: number;
  try {
    index = test.info().parallelIndex;
  } catch {
    index = Math.floor(Math.random() * CODE_CHARS.length); // テストの外（モジュールの読み込み時など）
  }
  let n = codeCounter;
  codeCounter = (codeCounter + 1) % CODE_SPACE;
  let rest = "";
  for (let i = 0; i < 3; i++) {
    rest = CODE_CHARS[n % CODE_CHARS.length] + rest;
    n = Math.floor(n / CODE_CHARS.length);
  }
  return CODE_CHARS[index % CODE_CHARS.length] + rest;
}
