import type { Page } from "@playwright/test";
import { expect, noSession, randomFieldCode, test } from "./helpers";

// 1-2 圃場の登録と一覧。テスト農園 A でログイン済み（helpers の test がワーカーで 1 回だけ UI ログインし、
// Cookie を共有する。Supabase Auth のサインインにはレート制限があるため、テストごとにはログインしない）。
// 行は消さない（A は E2E 専用組織）ので、名前・記号は実行ごとに一意にする。
// iphone / desktop の 2 プロジェクトが同じ組織で並行して走るため、行の総数ではなく名前・記号で絞って検証する。

function uniqueName() {
  return `E2E圃場-${test.info().project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function openFields(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL("/");
  // ホームから導線で /fields へ
  await page.getByRole("link", { name: "圃場の設定" }).click();
  await expect(page).toHaveURL("/fields");
  await expect(page.getByRole("heading", { name: "圃場", exact: true })).toBeVisible();
  // 一覧の読み込みが終わるまで待つ
  await expect(page.getByText("読み込み中…")).toHaveCount(0);
}

async function fillAndSubmit(
  page: Page,
  v: { name: string; code: string; lat: string; lng: string },
) {
  await page.getByLabel("名前").fill(v.name);
  await page.getByLabel("圃場記号").fill(v.code);
  await page.getByLabel("緯度").fill(v.lat);
  await page.getByLabel("経度").fill(v.lng);
  await page.getByRole("button", { name: "登録" }).click();
}


test.describe("未ログイン", () => {
  test.use({ storageState: noSession });

  test("未ログインで /fields を開くと /login に遷移する", async ({ page }) => {
    await page.goto("/fields");
    await expect(page).toHaveURL("/login");
  });
});

test("1. 圃場を登録すると一覧に表示される", async ({ page }) => {
  await openFields(page);
  const name = uniqueName();
  const code = randomFieldCode();

  await fillAndSubmit(page, { name, code, lat: "26.5", lng: "127.9" });

  const row = page.getByTestId("field-row").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("field-code")).toHaveText(code);
  await expect(row.getByTestId("field-center")).toHaveText("26.5, 127.9");
  // 成功したらフォームが空に戻る
  await expect(page.getByLabel("名前")).toHaveValue("");

  // 再読み込みしても一覧に残っている（DB に保存されている）
  await page.reload();
  await expect(page.getByText("読み込み中…")).toHaveCount(0);
  await expect(page.getByTestId("field-row").filter({ hasText: name })).toHaveCount(1);

  // 行をタップすると詳細に遷移し、圃場名が表示される
  await page.getByTestId("field-row").filter({ hasText: name }).getByRole("link").click();
  await expect(page).toHaveURL(/\/fields\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("field-detail-name")).toHaveText(name);
});

test("2a. 名前が空なら登録できず、理由が表示される", async ({ page }) => {
  await openFields(page);
  const code = randomFieldCode();

  await fillAndSubmit(page, { name: "", code, lat: "26.5", lng: "127.9" });

  await expect(page.getByTestId("field-error-name")).toHaveText("圃場の名前を入力してください");
  await expect(page.getByTestId("field-row").filter({ hasText: code })).toHaveCount(0);
  // 他の入力値は保持される
  await expect(page.getByLabel("圃場記号")).toHaveValue(code);
});

test("2b. 代表点（緯度経度）が未指定なら登録できず、理由が表示される", async ({ page }) => {
  await openFields(page);
  const name = uniqueName();

  await fillAndSubmit(page, { name, code: randomFieldCode(), lat: "", lng: "" });

  await expect(page.getByTestId("field-error-lat")).toHaveText("代表点の緯度を入力してください");
  await expect(page.getByTestId("field-error-lng")).toHaveText("代表点の経度を入力してください");
  await expect(page.getByTestId("field-row").filter({ hasText: name })).toHaveCount(0);
});

test("2c. 緯度経度が範囲外なら登録できず、理由が表示される", async ({ page }) => {
  await openFields(page);
  const name = uniqueName();

  await fillAndSubmit(page, { name, code: randomFieldCode(), lat: "91", lng: "181" });

  await expect(page.getByTestId("field-error-lat")).toHaveText("緯度は -90〜90 の範囲で入力してください");
  await expect(page.getByTestId("field-error-lng")).toHaveText("経度は -180〜180 の範囲で入力してください");
  await expect(page.getByTestId("field-row").filter({ hasText: name })).toHaveCount(0);
});

test("2d. 圃場記号が不正なら登録できず、理由が表示される", async ({ page }) => {
  await openFields(page);
  const name = uniqueName();

  await fillAndSubmit(page, { name, code: "A-1", lat: "26.5", lng: "127.9" });

  await expect(page.getByTestId("field-error-code")).toHaveText(
    "圃場記号は英数字 1〜4 文字で入力してください",
  );
  await expect(page.getByTestId("field-row").filter({ hasText: name })).toHaveCount(0);
});

test("3. 同じ組織内で同じ名前の圃場は登録できない", async ({ page }) => {
  await openFields(page);
  const name = uniqueName();

  await fillAndSubmit(page, { name, code: randomFieldCode(), lat: "26.5", lng: "127.9" });
  await expect(page.getByTestId("field-row").filter({ hasText: name })).toHaveCount(1);

  // 同じ名前（記号は別）でもう一度
  await fillAndSubmit(page, { name, code: randomFieldCode(), lat: "26.6", lng: "128.0" });

  await expect(page.getByTestId("field-error")).toHaveText("同じ名前の圃場がすでにあります");
  await expect(page.getByTestId("field-row").filter({ hasText: name })).toHaveCount(1);
});

test("3b. 同じ組織内で同じ圃場記号の圃場は登録できない", async ({ page }) => {
  await openFields(page);
  const code = randomFieldCode();

  await fillAndSubmit(page, { name: uniqueName(), code, lat: "26.5", lng: "127.9" });
  await expect(page.getByTestId("field-row").filter({ hasText: code })).toHaveCount(1);

  const name2 = uniqueName();
  await fillAndSubmit(page, { name: name2, code, lat: "26.6", lng: "128.0" });

  await expect(page.getByTestId("field-error")).toHaveText("同じ圃場記号の圃場がすでにあります");
  await expect(page.getByTestId("field-row").filter({ hasText: name2 })).toHaveCount(0);
});
