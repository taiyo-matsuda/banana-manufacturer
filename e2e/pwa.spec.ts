import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, test } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";

// 1-10 PWA。完了条件 1（インストール可能の要件）と 2（オフラインでアプリの殻が開く）を 1 つずつ検証する。
// 完了条件 3（Cloudflare Access の手順書 docs/04_ops/deploy.md）は文書なので reviewer が読んで判定する。
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。
// Service Worker はブラウザコンテキストごとに新しく登録されるので、各テストで登録と制御の開始を待つ。

const THEME_COLOR = "#2f6f3e";

// 登録した SW がこのページを制御する（navigator.serviceWorker.controller が non-null になる）まで待つ。
// 初回の登録直後は controller が null で、activate の clients.claim() の後に付く。
async function waitForController(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: ACTION_TIMEOUT });
}

test("1. インストール可能の要件: manifest・アイコン・start_url・Service Worker の制御・iOS 用メタ", async ({ page, request }) => {
  // manifest が配信され、必要な項目を持つ
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("manifest");
  const manifest = await res.json();
  expect(manifest.name).toBe("バナナ生育記録");
  expect(manifest.short_name).toBe("バナナ記録");
  expect(manifest.start_url).toBe("/");
  expect(manifest.display).toBe("standalone");
  expect(manifest.lang).toBe("ja");
  expect(manifest.theme_color).toBe(THEME_COLOR);
  expect(manifest.background_color).toBeTruthy();

  const icons = manifest.icons as { src: string; sizes: string; type: string; purpose?: string }[];
  const any192 = icons.find((i) => i.sizes === "192x192" && i.purpose === "any");
  const any512 = icons.find((i) => i.sizes === "512x512" && i.purpose === "any");
  const maskable512 = icons.find((i) => i.sizes === "512x512" && i.purpose === "maskable");
  expect(any192, "192x192 purpose=any").toBeTruthy();
  expect(any512, "512x512 purpose=any").toBeTruthy();
  expect(maskable512, "512x512 purpose=maskable").toBeTruthy();
  for (const icon of icons) {
    expect(icon.type).toBe("image/png");
    const r = await request.get(icon.src);
    expect(r.status(), icon.src).toBe(200);
    expect(r.headers()["content-type"], icon.src).toContain("image/png");
  }

  // start_url が 200（ログイン済み）
  const start = await request.get(manifest.start_url);
  expect(start.status()).toBe(200);

  // Service Worker が登録され、ページを制御している
  await page.goto("/");
  await waitForController(page);
  const sw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { scope: reg?.scope ?? null, scriptURL: reg?.active?.scriptURL ?? null, controller: navigator.serviceWorker.controller?.scriptURL ?? null };
  });
  expect(sw.scope).toBe("http://127.0.0.1:3000/");
  expect(sw.scriptURL).toBe("http://127.0.0.1:3000/sw.js");
  expect(sw.controller).toBe("http://127.0.0.1:3000/sw.js");

  // sw.js は HTTP キャッシュに残さない
  const swRes = await request.get("/sw.js");
  expect(swRes.status()).toBe(200);
  expect(swRes.headers()["content-type"]).toContain("javascript");
  expect(swRes.headers()["cache-control"]).toContain("no-cache");

  // HTML の <head>: manifest のリンク、theme-color、iOS 用（apple-touch-icon / apple-mobile-web-app-capable）
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", THEME_COLOR);
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(page.locator('meta[name="mobile-web-app-capable"]')).toHaveAttribute("content", "yes");
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute("content", "default");
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "バナナ記録");
  const appleIcon = page.locator('link[rel="apple-touch-icon"]');
  await expect(appleIcon).toHaveAttribute("href", "/apple-touch-icon.png");
  const appleRes = await request.get("/apple-touch-icon.png");
  expect(appleRes.status()).toBe(200);
  expect(appleRes.headers()["content-type"]).toContain("image/png");
});

test("2a. オンラインで開いた茎の画面は、オフラインで再読み込みしてもキャッシュから表示される", async ({ page, context }) => {
  const field = await createField("E2EPWA");
  const code = `${field.code}-001`;
  const matId = await createMat(field.id, code);
  const stemId = await createStem(matId, { initialLeafCount: 3 });

  // 1 回目: SW の登録と制御の開始を待つ（この読み込み自体は SW が介入していないのでキャッシュされない）
  await page.goto(`/stems/${stemId}`);
  await expect(page.getByTestId("stem-mat-code")).toHaveText(code);
  await waitForController(page);
  // 2 回目: 制御下のナビゲーションなので、応答（HTML）が SW のキャッシュに入る
  await page.goto(`/stems/${stemId}`);
  await expect(page.getByTestId("stem-mat-code")).toHaveText(code);
  await expect(page.getByTestId("sync-pending-count")).toHaveText("0", { timeout: ACTION_TIMEOUT });

  // オフラインで再読み込み → キャッシュから同じ画面が出る
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("stem-mat-code")).toHaveText(code, { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("stem-cumulative-leaves")).toHaveText("3");
  // 記録ボタンもある（アプリの殻が動いている）
  await expect(page.getByTestId("leaves-new-1")).toBeVisible();
  await expect(page.getByTestId("offline-page")).toHaveCount(0);
  await context.setOffline(false);
});

test("2b. 未訪問の画面をオフラインで開くと、/offline の案内が表示される", async ({ page, context }) => {
  const field = await createField("E2EPWA未訪問");
  const matId = await createMat(field.id, `${field.code}-001`);
  const stemId = await createStem(matId);

  await page.goto("/");
  await waitForController(page);

  await context.setOffline(true);
  // 一度も開いていない茎の画面（キャッシュにない）
  await page.goto(`/stems/${stemId}`);
  const offline = page.getByTestId("offline-page");
  await expect(offline).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(offline.getByRole("heading", { name: "圏外です" })).toBeVisible();
  await expect(offline).toContainText("オンラインで開いたことのある画面");
  await expect(offline).toContainText("未同期の記録は、電波が戻ると自動で送信されます");
  await expect(offline.getByRole("link", { name: "ホームへ" })).toHaveAttribute("href", "/");
  await context.setOffline(false);
});

test("2c. /offline は未ログインでも /login に転送されない（SW がプリキャッシュできる）", async ({ browser }) => {
  const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const res = await anon.request.get("/offline", { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain("圏外です");
  } finally {
    await anon.close();
  }
});
