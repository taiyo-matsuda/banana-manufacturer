import type { Locator, Page } from "@playwright/test";
import { distanceM } from "../src/lib/geo";
import { expect, noSession, randomFieldCode, supabaseAsA, test } from "./helpers";

// 1-3 圃場マップと株の一括配置。完了条件 1〜5 を 1 つずつ検証する。
// テスト農園 A でログイン済み（helpers の test がワーカーで 1 回だけ UI ログインし、Cookie を共有する）。
// テストごとに新しい圃場を作る（行は消さないので名前・記号は一意にする）。
// Supabase Auth のサインインにはレート制限があるので、テストごとにサインインしない。
// 地理院タイルの画像の到着は待たない（ネットワーク依存）。地図コンテナと出典の表示で判定する。

const CENTER = { lat: 26.5, lng: 127.9 };

function uniqueName() {
  return `E2E地図-${test.info().project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// テスト用の圃場を DB に直接作る（1-2 で登録画面は検証済み）
async function createField() {
  const supabase = await supabaseAsA();
  const code = randomFieldCode();
  const { data, error } = await supabase
    .from("fields")
    .insert({ name: uniqueName(), code, center_lat: CENTER.lat, center_lng: CENTER.lng })
    .select("id, code")
    .single();
  if (error || !data) throw new Error(`圃場を作れません: ${error?.message}`);
  return { supabase, id: data.id as string, code: data.code as string };
}

async function openMap(page: Page, fieldId: string) {
  // 圃場の詳細から導線で地図へ
  await page.goto(`/fields/${fieldId}`);
  await page.getByRole("link", { name: "地図（株の配置）" }).click();
  await expect(page).toHaveURL(`/fields/${fieldId}/map`);
  const map = page.getByTestId("field-map");
  await expect(map).toBeVisible();
  await expect(map).toHaveAttribute("data-map-ready", "true");
  return map;
}

async function canvasCenter(map: Locator) {
  const box = await map.boundingBox();
  if (!box) throw new Error("地図の大きさが取れません");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

type GridInput = {
  rows: number;
  perRow: number;
  plantedAt?: string;
  originLabel?: "組織培養" | "購入吸芽";
};

// 配置を始める → 1 点目 → 2 点目（右へ 80px = 列は東向き） → フォーム → プレビュー
async function makePreview(page: Page, map: Locator, input: GridInput) {
  await page.getByRole("button", { name: "配置を始める" }).click();
  await expect(page.getByTestId("place-status")).toContainText("1 点目");
  const c = await canvasCenter(map);
  await page.mouse.click(c.x, c.y);
  await expect(page.getByTestId("place-status")).toContainText("2 点目");
  await expect(page.getByTestId("guide-marker-origin")).toHaveCount(1);
  await page.mouse.click(c.x + 80, c.y);
  await expect(page.getByTestId("guide-marker-direction")).toHaveCount(1);

  await page.getByLabel("列数").fill(String(input.rows));
  await page.getByLabel("1列の本数").fill(String(input.perRow));
  await expect(page.getByLabel("株間（m）")).toHaveValue("3");
  if (input.plantedAt) await page.getByLabel("植え付け日").fill(input.plantedAt);
  if (input.originLabel) await page.getByLabel(input.originLabel).check();
  await page.getByRole("button", { name: "プレビュー" }).click();

  const markers = page.getByTestId("preview-marker");
  await expect(markers).toHaveCount(input.rows * input.perRow);
  return markers;
}

async function readPoints(markers: Locator) {
  const n = await markers.count();
  const pts: { lat: number; lng: number }[] = [];
  for (let i = 0; i < n; i++) {
    const el = markers.nth(i);
    pts.push({
      lat: Number(await el.getAttribute("data-lat")),
      lng: Number(await el.getAttribute("data-lng")),
    });
  }
  return pts;
}

async function confirmAndWait(page: Page, expectedTotal: number) {
  await page.getByTestId("place-confirm").click();
  await expect(page.getByTestId("place-notice")).toContainText("株を保存しました");
  await expect(page.getByTestId("preview-marker")).toHaveCount(0);
  await expect(page.getByTestId("mat-marker")).toHaveCount(expectedTotal);
  await expect(page.getByTestId("mat-count")).toHaveText(`株 ${expectedTotal}`);
}

test.describe("未ログイン", () => {
  test.use({ storageState: noSession });

  test("未ログインで地図を開くと /login に遷移する", async ({ page }) => {
    const field = await createField();
    await page.goto(`/fields/${field.id}/map`);
    await expect(page).toHaveURL("/login");
  });
});

test("1. 地図に航空写真（地理院タイル）と出典が表示される", async ({ page }) => {
  const field = await createField();
  // 下地が地理院タイルの空中写真（seamlessphoto）であること: タイル画像の要求を記録する（到着は待たない）
  const tileUrls: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith("https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/")) tileUrls.push(r.url());
  });
  // MapLibre の worker の応答を記録する（読み込めないと "Worker failed to load" が出る）
  const workerStatuses: number[] = [];
  page.on("response", (r) => {
    if (r.url().includes("/maplibre/maplibre-gl-worker.mjs")) workerStatuses.push(r.status());
  });
  // 地図のエラー（MapLibre の worker 読み込み失敗など）を拾う
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const map = await openMap(page, field.id);

  // MapLibre のキャンバスが描画されている
  const canvas = map.locator("canvas.maplibregl-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box!.width).toBeGreaterThan(200);
  expect(box!.height).toBeGreaterThan(200);

  // 出典「地理院タイル」が常時表示（compact の折りたたみボタンではない）
  const attribution = map.locator(".maplibregl-ctrl-attrib");
  await expect(attribution).toBeVisible();
  await expect(attribution).toContainText("地理院タイル");
  await expect(attribution).not.toHaveClass(/maplibregl-compact/);
  await expect(attribution.getByRole("link", { name: /地理院タイル/ })).toHaveAttribute(
    "href",
    /maps\.gsi\.go\.jp/,
  );

  await expect.poll(() => tileUrls.length, { timeout: 15_000 }).toBeGreaterThan(0);
  // 初期ズームは 18 程度なので z=18 のタイルを要求している
  expect(tileUrls.some((u) => /\/seamlessphoto\/18\/\d+\/\d+\.jpg$/.test(u))).toBe(true);

  await expect(page.getByTestId("map-field-name")).toBeVisible();

  // MapLibre の worker が読み込めている
  await expect.poll(() => workerStatuses.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(workerStatuses.every((s) => s === 200)).toBe(true);
  await page.waitForTimeout(500);
  expect(errors.filter((e) => /worker|error/i.test(e))).toEqual([]);
});

test("2. 2列 × 3本で生成すると、6株が約 3m 間隔（2.5〜3.5m）で表示される", async ({ page }) => {
  const field = await createField();
  const map = await openMap(page, field.id);
  const markers = await makePreview(page, map, { rows: 2, perRow: 3 });

  const pts = await readPoints(markers);
  expect(pts).toHaveLength(6);
  // 各点の最も近い点までの距離が 2.5〜3.5m
  for (let i = 0; i < pts.length; i++) {
    const nearest = Math.min(
      ...pts.filter((_, j) => j !== i).map((q) => distanceM(pts[i], q)),
    );
    expect(nearest).toBeGreaterThanOrEqual(2.5);
    expect(nearest).toBeLessThanOrEqual(3.5);
  }
  // 2 × 3 の格子なら隣接する組は 7 組（列内 4 組 + 列間 3 組）
  let adjacent = 0;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const d = distanceM(pts[i], pts[j]);
      if (d >= 2.5 && d <= 3.5) adjacent++;
    }
  expect(adjacent).toBe(7);
  // 1 点目が最初の株、列は東向き（2 点目は右にタップした）
  const originMarker = page.getByTestId("guide-marker-origin");
  const origin = {
    lat: Number(await originMarker.getAttribute("data-lat")),
    lng: Number(await originMarker.getAttribute("data-lng")),
  };
  expect(distanceM(origin, pts[0])).toBeLessThan(0.01);
  expect(pts[1].lng).toBeGreaterThan(pts[0].lng);
  expect(Math.abs(pts[1].lat - pts[0].lat)).toBeLessThan(1e-6);

  // 画面上でも 6 点が重ならずに表示されている
  const boxes = await Promise.all(
    Array.from({ length: 6 }, (_, i) => markers.nth(i).boundingBox()),
  );
  for (const b of boxes) expect(b).not.toBeNull();
  const centers = boxes.map((b) => ({ x: b!.x + b!.width / 2, y: b!.y + b!.height / 2 }));
  for (let i = 0; i < 6; i++)
    for (let j = i + 1; j < 6; j++) {
      expect(Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y)).toBeGreaterThan(
        10,
      );
    }
});

test("3. 確定すると 6株が保存され、再読み込み後も表示される。株コードが連番になる", async ({
  page,
}) => {
  const field = await createField();
  const map = await openMap(page, field.id);
  await expect(page.getByTestId("mat-count")).toHaveText("株 0");

  await makePreview(page, map, { rows: 2, perRow: 3 });
  await confirmAndWait(page, 6);

  // 再読み込み後も 6 株
  await page.reload();
  await expect(page.getByTestId("field-map")).toHaveAttribute("data-map-ready", "true");
  const mats = page.getByTestId("mat-marker");
  await expect(mats).toHaveCount(6);
  const codesOnMap = (await mats.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.code))).sort();
  const expected = [1, 2, 3, 4, 5, 6].map((n) => `${field.code}-${String(n).padStart(3, "0")}`);
  expect(codesOnMap).toEqual(expected);

  // DB にも 6 行
  const { data: rows, error } = await field.supabase
    .from("mats")
    .select("code, status, field_id")
    .eq("field_id", field.id)
    .order("code");
  expect(error).toBeNull();
  expect(rows!.map((r) => r.code)).toEqual(expected);
  expect(rows!.every((r) => r.status === "active")).toBe(true);

  // 既に株がある圃場では、その続きの番号から
  await makePreview(page, map, { rows: 1, perRow: 2 });
  await confirmAndWait(page, 8);
  const { data: rows2 } = await field.supabase
    .from("mats")
    .select("code")
    .eq("field_id", field.id)
    .order("code");
  expect(rows2!.map((r) => r.code)).toEqual([
    ...expected,
    `${field.code}-007`,
    `${field.code}-008`,
  ]);
});

test("4. 株を1つドラッグしてから確定すると、動かした位置で保存される", async ({ page }) => {
  const field = await createField();
  const map = await openMap(page, field.id);
  const markers = await makePreview(page, map, { rows: 2, perRow: 3 });
  const before = await readPoints(markers);

  // 3 番目の点（1 列目の端）を右下へドラッグ（地図が画面内にあることを確かめてから）
  await map.scrollIntoViewIfNeeded();
  const target = markers.nth(2);
  await expect(target).toBeInViewport();
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const sx = box!.x + box!.width / 2;
  const sy = box!.y + box!.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 30, sy + 20, { steps: 5 });
  await page.mouse.move(sx + 60, sy + 40, { steps: 10 });
  await page.mouse.up();

  const after = await readPoints(markers);
  const moved = distanceM(before[2], after[2]);
  expect(moved).toBeGreaterThan(1);
  // 他の点は動いていない
  for (const i of [0, 1, 3, 4, 5]) expect(distanceM(before[i], after[i])).toBeLessThan(0.01);

  await confirmAndWait(page, 6);

  // DB の座標が、元のプレビュー位置ではなく、動かした位置になっている
  const { data: row, error } = await field.supabase
    .from("mats")
    .select("code, lat, lng")
    .eq("field_id", field.id)
    .eq("code", `${field.code}-003`)
    .single();
  expect(error).toBeNull();
  const saved = { lat: row!.lat as number, lng: row!.lng as number };
  expect(distanceM(saved, after[2])).toBeLessThan(0.01);
  expect(distanceM(saved, before[2])).toBeGreaterThan(1);
  expect(distanceM(saved, before[2])).toBeCloseTo(moved, 2);

  // 動かしていない株は元の位置のまま
  const { data: first } = await field.supabase
    .from("mats")
    .select("lat, lng")
    .eq("field_id", field.id)
    .eq("code", `${field.code}-001`)
    .single();
  expect(distanceM({ lat: first!.lat, lng: first!.lng }, before[0])).toBeLessThan(0.01);
});

test("5. 保存された株に、入力した品種・植え付け日・苗の種類が入っている", async ({ page }) => {
  const field = await createField();
  const map = await openMap(page, field.id);

  // 既定値: 品種 ドワーフナムワ、植え付け日 今日、苗の種類 組織培養
  await page.getByRole("button", { name: "配置を始める" }).click();
  const c = await canvasCenter(map);
  await page.mouse.click(c.x, c.y);
  await page.mouse.click(c.x + 80, c.y);
  await expect(page.getByLabel("品種")).toHaveValue(/[0-9a-f-]{36}/);
  await expect(page.getByLabel("品種").locator("option:checked")).toHaveText("ドワーフナムワ");
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  await expect(page.getByLabel("植え付け日")).toHaveValue(todayStr);
  await expect(page.getByLabel("組織培養")).toBeChecked();
  await page.getByRole("button", { name: "やめる" }).click();
  await expect(page.getByRole("button", { name: "配置を始める" })).toBeVisible();

  // 植え付け日と苗の種類を変えて確定
  await makePreview(page, map, {
    rows: 1,
    perRow: 2,
    plantedAt: "2026-10-01",
    originLabel: "購入吸芽",
  });
  await confirmAndWait(page, 2);

  const { data: cultivar } = await field.supabase
    .from("cultivars")
    .select("id")
    .eq("name", "ドワーフナムワ")
    .single();
  const { data: rows, error } = await field.supabase
    .from("mats")
    .select("code, cultivar_id, planted_at, origin_type, organization_id")
    .eq("field_id", field.id)
    .order("code");
  expect(error).toBeNull();
  expect(rows).toHaveLength(2);
  for (const r of rows!) {
    expect(r.cultivar_id).toBe(cultivar!.id);
    expect(r.planted_at).toBe("2026-10-01");
    expect(r.origin_type).toBe("sucker_purchased");
    // organization_id はトリガーが fields からコピーする（テスト農園 A）
    expect(r.organization_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  }
});
