import type { Page } from "@playwright/test";
import { offsetLatLng } from "../src/lib/geo";
import { ACTION_TIMEOUT, expect, supabaseAsA, test } from "./helpers";
import { CENTER, createField, createMat, createStem, openMap } from "./map-helpers";

// 2-8 現在地から近い株（画面 2）。完了条件 1・2 を 1 つずつ検証し、加えて
// 撤去した株は候補に出ない、accuracy 30 m で注意が出る（候補は 3 株のまま）、ホームの「近くの株を探す」から地図が開いて候補が出る、
// を検証する。
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。テストごとにログインしない。
// 現在地は Playwright の geolocation で固定する（context.grantPermissions(['geolocation']) で許可）。
// 株は supabaseAsA() で、現在地 HERE からの方位・距離が分かっている位置に置く。圃場の名前は E2E で始める（map-helpers の createField）。

const HERE = CENTER;
const view = (page: Page) => page.locator("main:visible");
const rows = (page: Page) => view(page).getByTestId("nearby-row");

type Field = Awaited<ReturnType<typeof createField>>;

// HERE から bearing の方向へ m メートルの位置に株を置く
async function matAt(field: Field, n: number, bearing: number, m: number) {
  const code = `${field.code}-${String(n).padStart(3, "0")}`;
  const id = await createMat(field.id, code, "2026-09-15", offsetLatLng(HERE, bearing, m));
  return { id, code };
}

// 近い順が分かっている圃場: 5 m 東（出蕾済みの茎）、9 m 北（栽培中の茎）、14 m 西（茎なし）、25 m 南
async function fieldWithKnownMats() {
  const field = await createField("E2E近い株");
  const east5 = await matAt(field, 1, 90, 5);
  const north9 = await matAt(field, 2, 0, 9);
  const west14 = await matAt(field, 3, 270, 14);
  const south25 = await matAt(field, 4, 180, 25);
  await createStem(east5.id, { status: "flowered" });
  await createStem(north9.id, { status: "active" });
  return { field, east5, north9, west14, south25 };
}

async function removeMat(matId: string) {
  const supabase = await supabaseAsA();
  const { error } = await supabase.rpc("remove_mat", {
    p_event_id: crypto.randomUUID(),
    p_mat_id: matId,
    p_occurred_at: new Date().toISOString(),
    p_reason: null,
  });
  expect(error).toBeNull();
}

// 候補の行の株コードと表示距離（m）
async function readRows(page: Page) {
  const n = await rows(page).count();
  const out: { code: string; distance: number; status: string }[] = [];
  for (let i = 0; i < n; i++) {
    const row = rows(page).nth(i);
    const text = (await row.getByTestId("nearby-distance").textContent()) ?? "";
    const match = /^(\d+) m$/.exec(text.trim());
    expect(match, `距離の表示「${text}」が「N m」の形`).not.toBeNull();
    out.push({
      code: (await row.getByTestId("nearby-code").textContent()) ?? "",
      distance: Number(match![1]),
      status: (await row.getByTestId("nearby-stem-status").textContent()) ?? "",
    });
  }
  return out;
}

test.describe("位置情報を許可", () => {
  test.use({ geolocation: { latitude: HERE.lat, longitude: HERE.lng, accuracy: 5 } });

  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(["geolocation"]);
  });

  test("1. 位置を固定した状態で、近い順に 3 株と距離が出る。タップで株の詳細へ", async ({ page }) => {
    const { field, east5, north9, west14 } = await fieldWithKnownMats();
    await openMap(page, field.id);

    // 押す前は候補も現在地の点も出ていない（開いただけでは取得しない）
    await expect(page.getByTestId("nearby")).toHaveCount(0);
    await expect(page.getByTestId("current-location-marker")).toHaveCount(0);

    await page.getByTestId("locate-button").click();

    // 地図に現在地の点（固定した位置・精度）が出る。株の点とは別の要素
    const me = page.getByTestId("current-location-marker");
    await expect(me).toHaveCount(1);
    expect(Number(await me.getAttribute("data-lat"))).toBeCloseTo(HERE.lat, 6);
    expect(Number(await me.getAttribute("data-lng"))).toBeCloseTo(HERE.lng, 6);
    await expect(me).toHaveAttribute("data-accuracy", "5");
    await expect(page.getByTestId("locate-button")).toHaveAttribute("data-locating", "false");
    await expect(page.getByTestId("locate-button")).toHaveText("現在地");

    // 近い順に 3 株（25 m の株は出ない）。距離は ±1 m
    await expect(rows(page)).toHaveCount(3);
    const got = await readRows(page);
    expect(got.map((r) => r.code)).toEqual([east5.code, north9.code, west14.code]);
    expect(Math.abs(got[0].distance - 5)).toBeLessThanOrEqual(1);
    expect(Math.abs(got[1].distance - 9)).toBeLessThanOrEqual(1);
    expect(Math.abs(got[2].distance - 14)).toBeLessThanOrEqual(1);
    // 代表の茎の状態
    expect(got.map((r) => r.status)).toEqual(["出蕾済み", "栽培中", "茎なし"]);
    // 精度が良い（5 m）ときは注意を出さない
    await expect(page.getByTestId("nearby-accuracy-warning")).toHaveCount(0);

    // 行のタップ領域は 44px 以上
    const box = await rows(page).first().getByRole("link").boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    // タップで株の詳細へ
    await rows(page).nth(1).getByRole("link").click();
    await expect(page).toHaveURL(`/mats/${north9.id}`, { timeout: ACTION_TIMEOUT });
    await expect(page.getByTestId("mat-code")).toHaveText(north9.code);
  });

  test("撤去した株は候補に出ない", async ({ page }) => {
    const { field, east5, north9, west14 } = await fieldWithKnownMats();
    // いちばん近い 2 m に株を置いて撤去する（栽培中の茎がある株は撤去できないので茎なし）→ 5 m・9 m・14 m の 3 株のまま
    const near2 = await matAt(field, 5, 45, 2);
    await removeMat(near2.id);
    await openMap(page, field.id);
    await page.getByTestId("locate-button").click();

    await expect(rows(page)).toHaveCount(3);
    const got = await readRows(page);
    expect(got.map((r) => r.code)).toEqual([east5.code, north9.code, west14.code]);
    await expect(view(page).locator(`[data-testid="nearby-row"][data-mat-code="${near2.code}"]`)).toHaveCount(0);
    // 地図にも撤去した株の点は出ない
    await expect(page.locator(`[data-testid="mat-marker"][data-code="${near2.code}"]`)).toHaveCount(0);
  });

  test("accuracy が 30 m なら誤差の注意が候補の上に出て、候補は 3 株のまま", async ({ page, context }) => {
    const { field, east5, north9, west14 } = await fieldWithKnownMats();
    await context.setGeolocation({ latitude: HERE.lat, longitude: HERE.lng, accuracy: 30 });
    await openMap(page, field.id);
    await page.getByTestId("locate-button").click();

    const warning = page.getByTestId("nearby-accuracy-warning");
    await expect(warning).toHaveText("位置の誤差が大きい（± 30 m）。候補の順番は目安です");
    await expect(page.getByTestId("current-location-marker")).toHaveAttribute("data-accuracy", "30");
    await expect(rows(page)).toHaveCount(3);
    expect((await readRows(page)).map((r) => r.code)).toEqual([east5.code, north9.code, west14.code]);

    // 注意は候補（一覧）より上
    const w = await warning.boundingBox();
    const first = await rows(page).first().boundingBox();
    expect(w!.y + w!.height).toBeLessThanOrEqual(first!.y);
  });

  test("ホームの「近くの株を探す」から圃場を選ぶと地図が開き、すぐに近い株が出る", async ({ page }) => {
    const { field, east5, north9, west14 } = await fieldWithKnownMats();
    const supabase = await supabaseAsA();
    const { data } = await supabase.from("fields").select("name").eq("id", field.id).single();
    const name = data!.name as string;

    await page.goto("/");
    // 「今週見る株」より下にある
    const weekly = await page.getByTestId("home-weekly").boundingBox();
    const nearby = page.getByTestId("home-nearby");
    await expect(nearby).toBeVisible();
    const nb = await nearby.boundingBox();
    expect(nb!.y).toBeGreaterThanOrEqual(weekly!.y + weekly!.height);

    await page.getByRole("link", { name: "近くの株を探す" }).click();
    // テスト農園 A には圃場が複数あるので、圃場の選択 → 地図（?locate=1）
    await expect(page).toHaveURL("/map?locate=1", { timeout: ACTION_TIMEOUT });
    await view(page).getByRole("link", { name: new RegExp(name) }).click();
    await expect(page).toHaveURL(`/fields/${field.id}/map?locate=1`, { timeout: ACTION_TIMEOUT });

    // ボタンを押さなくても、開いた直後に現在地を取って候補が出る
    await expect(page.getByTestId("current-location-marker")).toHaveCount(1, { timeout: ACTION_TIMEOUT });
    await expect(rows(page)).toHaveCount(3);
    expect((await readRows(page)).map((r) => r.code)).toEqual([east5.code, north9.code, west14.code]);
  });
});

test.describe("位置情報を許可しない", () => {
  test("2. 位置情報が拒否されても理由が表示され、地図の株をタップして株の詳細に行ける", async ({ page, context }) => {
    // 許可を与えない（Playwright は既定で位置情報を拒否する）
    await context.clearPermissions();
    const { field, north9 } = await fieldWithKnownMats();
    const map = await openMap(page, field.id);

    await page.getByTestId("locate-button").click();

    const error = page.getByTestId("locate-error");
    await expect(error).toHaveAttribute("data-kind", "denied");
    await expect(error).toContainText("位置情報の利用が許可されていません");
    await expect(error).toContainText("設定アプリ → Safari（または ホーム画面のアプリ）→ 位置情報 で許可してください");
    // 理由は地図の上
    const e = await error.boundingBox();
    const m = await map.boundingBox();
    expect(e!.y + e!.height).toBeLessThanOrEqual(m!.y + 1);

    // 候補・現在地の点は出ない。地図はそのまま使える（株の点・配置のボタン）
    await expect(page.getByTestId("nearby")).toHaveCount(0);
    await expect(page.getByTestId("current-location-marker")).toHaveCount(0);
    await expect(map).toHaveAttribute("data-map-ready", "true");
    await expect(page.getByTestId("mat-marker")).toHaveCount(4);
    await expect(page.getByRole("button", { name: "配置を始める" })).toBeEnabled();
    await expect(page.getByTestId("locate-button")).toBeEnabled();

    // 株の点をタップすると株の詳細へ
    await page.locator(`[data-testid="mat-marker"][data-code="${north9.code}"]`).click();
    await expect(page).toHaveURL(`/mats/${north9.id}`, { timeout: ACTION_TIMEOUT });
    await expect(page.getByTestId("mat-code")).toHaveText(north9.code);
  });
});
