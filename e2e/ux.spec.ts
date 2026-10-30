import type { Locator, Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, test, waitForSynced } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";

// UX-1 共通 UI 部品と全画面への適用。完了条件 1〜4、6 を 1 つずつ検証する。
// （5「既存の E2E が全件通る」は他の spec の結果、2 の「生の <input> / <button> が無い」は grep で reviewer が確認する）
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。テストごとにログインしない。
// 圃場はワーカー（プロジェクト）ごとに 1 つだけ作り、株・茎はテストごとに分ける（leaves.spec と同じ方針）。

let field: Awaited<ReturnType<typeof createField>>;
let matSeq = 0;

test.beforeAll(async () => {
  field = await createField("E2E-UX");
});

async function setupStem() {
  matSeq += 1;
  const code = `${field.code}-${String(matSeq).padStart(3, "0")}`;
  const matId = await createMat(field.id, code);
  const stemId = await createStem(matId, { initialLeafCount: 4 });
  return { code, matId, stemId };
}

// クライアント遷移では前の画面の DOM が非表示で残る（Next.js）ので、表示中のものに絞る
const visible = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]:visible`);
const view = (page: Page) => page.locator("main:visible");

// タップ領域の下限（UX-1 完了条件 6）
const MIN_TAP = 44;
const RECORD_BUTTON_MIN = 64;

async function expectMinHeight(locator: Locator, min: number) {
  const box = await locator.boundingBox();
  expect(box, `要素が見つかりません: ${locator}`).not.toBeNull();
  expect(box!.height, `高さ ${box!.height}px < ${min}px: ${locator}`).toBeGreaterThanOrEqual(min);
  expect(box!.width, `幅 ${box!.width}px < ${min}px: ${locator}`).toBeGreaterThanOrEqual(min);
}

// --- 完了条件 1: どの画面からも 2 タップ以内でホームへ。ホームから地図・圃場・直近の株へ 1 タップ ------------------

test("1a. 各画面のヘッダの「ホーム」でホームに戻れる（1 タップ）", async ({ page }) => {
  const { matId, stemId } = await setupStem();
  const screens = [
    `/fields`,
    `/fields/new`,
    `/fields/${field.id}`,
    `/fields/${field.id}/map`,
    `/mats/${matId}`,
    `/stems/${stemId}`,
    `/stems/${stemId}/history`,
    `/forecast`,
  ];
  for (const url of screens) {
    await page.goto(url);
    await expect(page.getByText("読み込み中…")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
    await expect(page.getByText("地図を読み込み中…")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
    const home = visible(page, "home-link");
    await expect(home, url).toBeVisible();
    await expect(home).toHaveAttribute("href", "/");
    await home.click();
    await expect(page, `${url} からホームへ`).toHaveURL("/");
    await expect(page.getByTestId("organization-name")).toBeVisible();
  }
});

test("1b. 各画面の下部タブ「ホーム」でもホームに戻れ、ログイン・オフライン画面には下部タブが無い", async ({ page }) => {
  const { stemId } = await setupStem();
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("leaves-new-1")).toBeVisible();
  const nav = page.locator('[data-testid="bottom-nav"]:visible');
  await expect(nav).toBeVisible();
  await expect(nav.getByTestId("nav-map")).toHaveAttribute("aria-current", "page");
  await nav.getByTestId("nav-home").click();
  await expect(page).toHaveURL("/");
  await expect(page.locator('[data-testid="bottom-nav"]:visible').getByTestId("nav-home")).toHaveAttribute("aria-current", "page");

  // 下部タブの行き先: 地図 / 予測 / 設定
  await expect(nav.getByTestId("nav-forecast")).toHaveAttribute("href", "/forecast");
  await expect(nav.getByTestId("nav-settings")).toHaveAttribute("href", "/fields");
  // 地図タブは直近の圃場の地図、未記録なら地図用の圃場選択（1d / 1f / 1g で検証）
  await expect(nav.getByTestId("nav-map")).toHaveAttribute("href", /^\/(map|fields\/[0-9a-f-]{36}\/map)$/);

  // オフライン画面には下部タブもヘッダのホーム以外の導線も要らないが、ホームへは 1 タップ
  await page.goto("/offline");
  await expect(page.getByRole("heading", { name: "圏外です" })).toBeVisible();
  await expect(page.getByTestId("bottom-nav")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "ホームへ" })).toHaveAttribute("href", "/");
});

test("1c. 株の詳細 ← 茎の記録: ヘッダの「戻る」で 1 つ上に戻れる（ホームまで 2 タップ以内）", async ({ page }) => {
  const { code, matId, stemId } = await setupStem();
  // 読み込み中のヘッダには「戻る」が無い（戻る先は読んでから決まる）ので、本文が出てから押す
  const back = async (expectedHref: string) => {
    const link = visible(page, "back-link");
    await expect(link).toHaveAttribute("href", expectedHref);
    await link.click();
    await expect(page).toHaveURL(expectedHref);
  };
  await page.goto(`/stems/${stemId}/history`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(code);
  // 履歴 → 記録入力 → 株の詳細 → 地図 → 圃場の詳細 → 圃場の一覧 → ホーム（すべて「戻る」）
  await back(`/stems/${stemId}`);
  await expect(view(page).getByTestId("leaves-new-1")).toBeVisible();
  await back(`/mats/${matId}`);
  await expect(view(page).getByTestId("mat-code")).toHaveText(code);
  await back(`/fields/${field.id}/map`);
  await expect(visible(page, "map-field-name")).toBeVisible();
  await back(`/fields/${field.id}`);
  await expect(visible(page, "field-detail-name")).toBeVisible();
  await back("/fields");
  await back("/");
});

test("1d. ホームから圃場（1 タップ）・直近の株（1 タップ）・地図（下部タブ 1 タップ）にたどれる", async ({ page }) => {
  const { code, matId } = await setupStem();

  // 株の詳細を開くと「最近開いた株」に残る
  await page.goto(`/mats/${matId}`);
  await expect(view(page).getByTestId("mat-code")).toHaveText(code);

  await page.goto("/");
  await expect(page.getByTestId("organization-name")).toBeVisible();

  // 圃場: 名前のタップで圃場の詳細へ
  const fieldRow = page.getByTestId("home-field-row").filter({ hasText: field.code });
  await expect(fieldRow).toHaveCount(1);
  await fieldRow.getByRole("link").click();
  await expect(page).toHaveURL(`/fields/${field.id}`);

  // 直近の株: 先頭に今開いた株
  await page.goto("/");
  const recent = page.getByTestId("recent-mat-row");
  await expect(recent.first()).toContainText(code);
  await recent.first().getByRole("link").click();
  await expect(page).toHaveURL(`/mats/${matId}`);

  // 地図タブ: 直近に開いた株の圃場の地図へ 1 タップで届く（テスト農園 A には圃場が複数ある）
  await page.goto("/");
  const mapTab = page.locator('[data-testid="bottom-nav"]:visible').getByTestId("nav-map");
  await expect(mapTab).toHaveAttribute("href", `/fields/${field.id}/map`);
  await mapTab.click();
  await expect(page).toHaveURL(`/fields/${field.id}/map`, { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("field-map")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(page.locator('[data-testid="bottom-nav"]:visible').getByTestId("nav-map")).toHaveAttribute("aria-current", "page");
});

test("1f. 圃場が複数あり、まだどの地図も開いていないとき: 地図タブ → 地図用の圃場選択（地図タブ強調）→ 1 タップで地図", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("organization-name")).toBeVisible();
  // 端末の記録を消す（初めて使う端末と同じ）
  await page.evaluate(() => window.localStorage.removeItem("last-field"));
  await page.reload();
  await expect(page.getByTestId("organization-name")).toBeVisible();
  const mapTab = page.locator('[data-testid="bottom-nav"]:visible').getByTestId("nav-map");
  await expect(mapTab).toHaveAttribute("href", "/map");
  await mapTab.click();
  await expect(page).toHaveURL("/map");
  await expect(page.getByTestId("map-field-picker")).toBeVisible({ timeout: ACTION_TIMEOUT });
  expect(await page.getByTestId("map-field-row").count()).toBeGreaterThan(1);
  const nav = page.locator('[data-testid="bottom-nav"]:visible');
  await expect(nav.getByTestId("nav-map")).toHaveAttribute("aria-current", "page");
  await expect(nav.getByTestId("nav-settings")).not.toHaveAttribute("aria-current", "page");

  await page.getByTestId("map-field-row").filter({ hasText: field.code }).getByRole("link").click();
  await expect(page).toHaveURL(`/fields/${field.id}/map`);
  await expect(page.getByTestId("field-map")).toHaveAttribute("data-map-ready", "true", { timeout: ACTION_TIMEOUT });
  // 開いた圃場が次から地図タブの行き先になる
  await page.goto("/");
  await expect(page.locator('[data-testid="bottom-nav"]:visible').getByTestId("nav-map")).toHaveAttribute(
    "href",
    `/fields/${field.id}/map`,
  );
});

test("1g. 端末に残った「最近開いた株」「直近の圃場」が別のユーザーのものなら、ホームを開いたときに消える", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("organization-name")).toBeVisible();
  await page.evaluate(() => {
    window.localStorage.setItem("device-owner", "00000000-0000-4000-8000-000000000000");
    window.localStorage.setItem(
      "recent-mats",
      JSON.stringify([{ id: "11111111-1111-4111-8111-111111111111", code: "ZZ-001", fieldName: "他人の圃場", openedAt: "" }]),
    );
    window.localStorage.setItem("last-field", JSON.stringify({ id: "22222222-2222-4222-8222-222222222222", name: "他人の圃場" }));
  });
  await page.reload();
  await expect(page.getByTestId("organization-name")).toBeVisible();
  await expect(page.getByTestId("recent-mats-empty")).toBeVisible();
  await expect(page.getByTestId("recent-mat-row")).toHaveCount(0);
  await expect(page.locator('[data-testid="bottom-nav"]:visible').getByTestId("nav-map")).toHaveAttribute("href", "/map");
});

test("1h. 見つからない画面（404）にもヘッダのホームと下部タブがあり、ホームに戻れる", async ({ page }) => {
  for (const url of ["/mats/00000000-0000-0000-0000-000000000000", "/no-such-page"]) {
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible({ timeout: ACTION_TIMEOUT });
    await expect(page.getByTestId("not-found")).toContainText("見つかりません");
    await expect(page.locator('[data-testid="bottom-nav"]:visible')).toBeVisible();
    await visible(page, "home-link").click();
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("organization-name")).toBeVisible();
  }
});

test("1e. 最近開いた株は直近 5 件で、同じ株は 1 つにまとまる", async ({ page }) => {
  const mats: { code: string; matId: string }[] = [];
  for (let i = 0; i < 6; i++) mats.push(await setupStem());
  for (const m of mats) {
    await page.goto(`/mats/${m.matId}`);
    await expect(view(page).getByTestId("mat-code")).toHaveText(m.code);
  }
  // 最初の株をもう一度開く → 先頭へ移る
  await page.goto(`/mats/${mats[0].matId}`);
  await expect(view(page).getByTestId("mat-code")).toHaveText(mats[0].code);

  await page.goto("/");
  const rows = page.getByTestId("recent-mat-row");
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText(mats[0].code);
  await expect(rows.nth(1)).toContainText(mats[5].code);
  await expect(rows.nth(4)).toContainText(mats[2].code);
  // 6 件目以降（mats[1]）は落ちている
  await expect(rows.filter({ hasText: mats[1].code })).toHaveCount(0);
});

// --- 完了条件 3: 圃場の一覧に登録フォームが同居していない -------------------------------------------------------

test("3. /fields は一覧だけで登録フォームが無く、「圃場を追加」で /fields/new に移って登録できる", async ({ page }) => {
  await page.goto("/fields");
  await expect(page.getByText("読み込み中…")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "圃場", exact: true })).toBeVisible();
  // 一覧の画面にフォームも入力欄も無い
  await expect(page.locator("main form")).toHaveCount(1); // ログアウトの form だけ
  await expect(page.getByTestId("field-form")).toHaveCount(0);
  // （Server Action の form には React が hidden input を足すので、それは除く）
  await expect(page.locator("main input:not([type=hidden])")).toHaveCount(0);
  await expect(page.getByTestId("logout")).toBeVisible();

  // 「圃場を追加」→ 別画面
  await page.getByTestId("field-add").click();
  await expect(page).toHaveURL("/fields/new");
  await expect(page.getByTestId("field-form")).toBeVisible();
  await expect(page.getByLabel("名前")).toBeVisible();
  // 登録画面の「戻る」は一覧へ
  await expect(visible(page, "back-link")).toHaveAttribute("href", "/fields");
});

// --- 完了条件 4: 茎の記録入力で +1 / +2 が主役、+0 相当は控えめ。記録の挙動は 1-6 と同じ ----------------------

test("4. +1 / +2 は高さ 64px 以上の大きなボタン、「増えていない」は小さなリンク。どちらも leaves_new を記録する", async ({ page }) => {
  const { code, stemId } = await setupStem();
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(code);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("4");

  const plus1 = view(page).getByTestId("leaves-new-1");
  const plus2 = view(page).getByTestId("leaves-new-2");
  const zero = view(page).getByTestId("leaves-new-0");
  await expectMinHeight(plus1, RECORD_BUTTON_MIN);
  await expectMinHeight(plus2, RECORD_BUTTON_MIN);
  // 幅いっぱい（2 つ並べてカードの内側の幅いっぱい。本文幅の 8 割以上）
  const main = await view(page).locator("article").boundingBox();
  const b1 = (await plus1.boundingBox())!;
  const b2 = (await plus2.boundingBox())!;
  expect(b1.width + b2.width).toBeGreaterThanOrEqual(main!.width * 0.8);
  expect(Math.abs(b1.width - b2.width)).toBeLessThanOrEqual(1);

  // +0 は控えめ: 主役より低く・細く、リンク（link variant）の見た目で、塗りつぶしの背景が無い
  const z = (await zero.boundingBox())!;
  expect(z.height).toBeLessThan(b1.height * 0.75);
  expect(z.width).toBeLessThan(b1.width + b2.width);
  await expect(zero).toHaveAttribute("data-variant", "link");
  const zeroBg = await zero.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(zeroBg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  await expect(zero).toContainText("増えていない");

  // 記録の挙動は 1-6 と同じ: +1 → 5、「増えていない」→ 5 のまま（leaves_new=0 の記録が履歴に残る）、+2 → 7
  await plus1.click();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("5");
  await zero.click();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("5");
  await expect(view(page).locator('[data-testid="history-item"][data-type="leaves_new"]')).toHaveCount(2);
  await expect(view(page).locator('[data-testid="history-item"][data-type="leaves_new"]').first().getByTestId("history-value")).toHaveText("+0");
  await plus2.click();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("7");
  await waitForSynced(page);
  await page.reload();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("7");
  await expect(view(page).locator('[data-testid="history-item"][data-type="leaves_new"]')).toHaveCount(3);
});

// --- 完了条件 6 / 2: タップ領域 44px 以上、入力欄・ボタンのサイズが揃っている --------------------------------------

test("6a. 主要なボタン・下部タブ・ヘッダの導線は 44px 以上", async ({ page }) => {
  const { code, stemId } = await setupStem();
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(code);

  // 下部タブ 4 つ
  const nav = page.locator('[data-testid="bottom-nav"]:visible');
  for (const key of ["home", "map", "forecast", "settings"]) await expectMinHeight(nav.getByTestId(`nav-${key}`), MIN_TAP);
  // ヘッダ: 戻る・ホーム・未同期
  await expectMinHeight(visible(page, "back-link"), MIN_TAP);
  await expectMinHeight(visible(page, "home-link"), MIN_TAP);
  await expectMinHeight(page.getByTestId("sync-indicator"), MIN_TAP);
  // 記録入力のボタン類
  for (const id of ["leaves-new-submit", "leaves-removed-submit", "leaves-current-submit", "stem-history-link"]) {
    await expectMinHeight(view(page).getByTestId(id), MIN_TAP);
  }
  for (const b of await view(page).locator('[data-testid^="event-button-"]').all()) await expectMinHeight(b, MIN_TAP);
  await expectMinHeight(view(page).getByTestId("photo-status").locator(".."), MIN_TAP);
});

test("6b. 入力欄の高さが画面をまたいで揃っている（登録フォーム・記録入力・イベントのダイアログ）", async ({ page }) => {
  const { code, stemId } = await setupStem();

  // 圃場の登録: 4 つの入力欄が同じ高さで 44px 以上
  await page.goto("/fields/new");
  const inputs = page.locator('[data-slot="input"]:visible');
  await expect(inputs).toHaveCount(4);
  const heights = new Set<number>();
  for (const input of await inputs.all()) {
    const box = (await input.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(MIN_TAP);
    heights.add(Math.round(box.height));
  }
  expect(heights.size).toBe(1);
  const fieldInputHeight = [...heights][0];

  // 茎の記録入力: 数値入力と select も同じ高さ
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(code);
  for (const id of ["leaves-new-input", "leaves-removed-input", "leaves-current-input", "photo-kind"]) {
    const box = (await view(page).getByTestId(id).boundingBox())!;
    expect(Math.round(box.height), id).toBe(fieldInputHeight);
  }

  // イベントのダイアログ: 日付と数値入力も同じ高さ。ボタンは 44px 以上
  await view(page).getByTestId("event-button-bud_emerged").click();
  const dialog = page.getByTestId("event-dialog");
  await expect(dialog).toBeVisible();
  // 開くときの拡大アニメーションが終わってから測る
  await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  for (const id of ["event-date", "event-earliest-at", "event-leaves-current", "event-girth-cm"]) {
    const box = (await dialog.getByTestId(id).boundingBox())!;
    expect(Math.round(box.height), id).toBe(fieldInputHeight);
  }
  await expectMinHeight(dialog.getByTestId("event-cancel"), MIN_TAP);
  await expectMinHeight(dialog.getByTestId("event-submit"), MIN_TAP);
  await dialog.getByTestId("event-cancel").click();
  await expect(page.getByTestId("event-dialog")).toHaveCount(0);
});

test("6c. 予測タブは予測一覧（3-6）で、ヘッダと下部タブがある", async ({ page }) => {
  await page.goto("/forecast");
  await expect(page.getByRole("heading", { name: "予測" })).toBeVisible();
  await expect(page.getByTestId("forecast-weeks")).toBeVisible();
  await expect(page.getByTestId("bottom-nav").getByTestId("nav-forecast")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("home-link")).toBeVisible();
});

test("6d. 地図画面: 株の点・拡大縮小・地図の下のボタンのタップ領域が 44px 以上で、点の当たり判定の端をタップしても株の詳細に行ける", async ({ page }) => {
  const { matId } = await setupStem();
  await page.goto(`/fields/${field.id}/map`);
  const map = page.getByTestId("field-map");
  await expect(map).toHaveAttribute("data-map-ready", "true", { timeout: ACTION_TIMEOUT });

  const marker = page.locator(`[data-testid="mat-marker"][data-mat-id="${matId}"]`);
  await expect(marker).toHaveCount(1);
  await expectMinHeight(marker, MIN_TAP);
  // 見た目の点は小さいまま（当たり判定だけ大きい）
  const dot = (await marker.locator("div").first().boundingBox())!;
  expect(dot.width).toBeLessThan(MIN_TAP / 2);

  await expectMinHeight(map.locator(".maplibregl-ctrl-zoom-in"), MIN_TAP);
  await expectMinHeight(map.locator(".maplibregl-ctrl-zoom-out"), MIN_TAP);
  await expectMinHeight(view(page).getByRole("button", { name: "配置を始める" }), MIN_TAP);
  await expectMinHeight(view(page).getByRole("button", { name: "1株追加" }), MIN_TAP);
  await expectMinHeight(visible(page, "back-link"), MIN_TAP);
  await expectMinHeight(visible(page, "home-link"), MIN_TAP);
  const nav = page.locator('[data-testid="bottom-nav"]:visible');
  for (const key of ["home", "map", "forecast", "settings"]) await expectMinHeight(nav.getByTestId(`nav-${key}`), MIN_TAP);

  // 配置モードの「やめる」も 44px 以上
  await view(page).getByRole("button", { name: "配置を始める" }).click();
  await expectMinHeight(view(page).getByRole("button", { name: "やめる" }), MIN_TAP);
  await view(page).getByRole("button", { name: "やめる" }).click();
  await expect(view(page).getByRole("button", { name: "配置を始める" })).toBeVisible();

  // 当たり判定の端（見た目の点の外側）をタップしても株の詳細へ。
  // この圃場の株は同じ位置に重なって置かれる（createMat）ので、行き先は「株の詳細」であることだけ見る
  await marker.scrollIntoViewIfNeeded();
  const box = (await marker.boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + 4);
  await expect(page).toHaveURL(/\/mats\/[0-9a-f-]{36}$/, { timeout: ACTION_TIMEOUT });
});
