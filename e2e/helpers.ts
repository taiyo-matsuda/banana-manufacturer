import { expect, type Page } from "@playwright/test";

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

// ログインしてホームに遷移するところまで
export async function login(page: Page, email: string, password: string) {
  await submitLogin(page, email, password);
  await expect(page).toHaveURL("/");
}

// 圃場記号（英数字 1〜4 文字、組織内で unique）をテストごとに一意にする。
// 0005 のバックフィルが付けた `X001…` と衝突しないよう、X は使わない。
export function randomFieldCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWYZ0123456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
