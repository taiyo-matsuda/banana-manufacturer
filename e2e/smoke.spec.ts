import { test, expect } from "@playwright/test";

// ハーネスの動作確認用。アプリが起動し、トップページが表示されることだけを見る。
test("トップページが表示される", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
});
