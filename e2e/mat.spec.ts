import { distanceM } from "../src/lib/geo";
import {
  ACTION_TIMEOUT,
  AUTH_STATE_B,
  expect,
  noSession,
  supabaseAsA,
  supabaseAsB,
  test,
} from "./helpers";
import { canvasCenter, CENTER, createField, openMap } from "./map-helpers";

// 1-4 株の個別追加と株の詳細。完了条件 1〜2 を 1 つずつ検証する。
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。テストごとにログインしない。
// テストが作る圃場の名前は E2E で始める（setup の掃除で圃場・株・茎ごと消える）。

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function dwarfNamwaId() {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("cultivars")
    .select("id")
    .eq("name", "ドワーフナムワ")
    .single();
  if (error || !data) throw new Error(`品種を取得できません: ${error?.message}`);
  return data.id as string;
}

// 株を DB に直接作る（株の追加 UI は条件 1 で検証する。条件 2 は詳細画面だけを見たい）
async function createMat(fieldId: string, code: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("mats")
    .insert({
      field_id: fieldId,
      code,
      cultivar_id: await dwarfNamwaId(),
      lat: CENTER.lat,
      lng: CENTER.lng,
      planted_at: "2026-09-15",
      origin_type: "tissue_culture",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`株を作れません: ${error?.message}`);
  return data.id as string;
}

test("1. 株を1つ追加でき、地図と詳細に反映される", async ({ page }) => {
  const field = await createField("E2E株追加");
  const map = await openMap(page, field.id);
  await expect(page.getByTestId("mat-count")).toHaveText("株 0");

  // 「1株追加」→ 空いている位置をタップ → フォーム
  await page.getByRole("button", { name: "1株追加" }).click();
  await expect(page.getByTestId("place-status")).toContainText("位置を地図でタップ");
  await expect(map).toHaveAttribute("data-mode", "pick-single");
  const c = await canvasCenter(map);
  await page.mouse.click(c.x, c.y);
  await expect(map).toHaveAttribute("data-mode", "single-form");
  const guide = page.getByTestId("guide-marker-single");
  await expect(guide).toHaveCount(1);
  const tapped = {
    lat: Number(await guide.getAttribute("data-lat")),
    lng: Number(await guide.getAttribute("data-lng")),
  };
  // タップした位置は圃場の代表点（地図の中心）のごく近く
  expect(distanceM(tapped, CENTER)).toBeLessThan(2);

  // 既定値: 株がない圃場では品種はドワーフナムワ
  await expect(page.getByLabel("品種").locator("option:checked")).toHaveText("ドワーフナムワ");
  await page.getByLabel("植え付け日").fill("2026-10-05");
  await page.getByLabel("購入吸芽").check();
  await page.getByTestId("single-confirm").click();

  // 確定は Server Action（insert ＋ refresh）。地図に 1 株、株コードは 001
  const code1 = `${field.code}-001`;
  await expect(page.getByTestId("place-notice")).toContainText(`株 ${code1} を追加しました`, {
    timeout: ACTION_TIMEOUT,
  });
  await expect(map).toHaveAttribute("data-mode", "idle");
  const marker = page.getByTestId("mat-marker");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("data-code", code1);
  await expect(page.getByTestId("mat-count")).toHaveText("株 1");

  // DB にも 1 行。位置・品種・植え付け日・苗の種類が入っている。organization_id はトリガーがコピー
  const { data: row, error } = await field.supabase
    .from("mats")
    .select("id, code, lat, lng, cultivar_id, planted_at, origin_type, status, organization_id")
    .eq("field_id", field.id)
    .single();
  expect(error).toBeNull();
  expect(row!.code).toBe(code1);
  expect(distanceM({ lat: row!.lat, lng: row!.lng }, tapped)).toBeLessThan(0.01);
  expect(row!.cultivar_id).toBe(await dwarfNamwaId());
  expect(row!.planted_at).toBe("2026-10-05");
  expect(row!.origin_type).toBe("sucker_purchased");
  expect(row!.status).toBe("active");
  expect(row!.organization_id).toBe(ORG_A);

  // 再読み込み後も地図に表示される
  await page.reload();
  await expect(page.getByTestId("field-map")).toHaveAttribute("data-map-ready", "true", {
    timeout: ACTION_TIMEOUT,
  });
  await expect(page.getByTestId("mat-marker")).toHaveCount(1);
  await expect(page.getByTestId("mat-marker")).toHaveAttribute("data-mat-id", row!.id);

  // 2 株目は連番（002）。既に株がある圃場では品種の既定値は最後に登録した株の品種
  await page.getByRole("button", { name: "1株追加" }).click();
  await page.mouse.click(c.x + 60, c.y + 40);
  await expect(map).toHaveAttribute("data-mode", "single-form");
  await expect(page.getByLabel("品種").locator("option:checked")).toHaveText("ドワーフナムワ");
  await page.getByTestId("single-confirm").click();
  const code2 = `${field.code}-002`;
  await expect(page.getByTestId("place-notice")).toContainText(`株 ${code2} を追加しました`, {
    timeout: ACTION_TIMEOUT,
  });
  await expect(page.getByTestId("mat-marker")).toHaveCount(2);
  await expect(page.getByTestId("mat-count")).toHaveText("株 2");

  // 地図の株をタップすると株の詳細が開き、追加した内容が表示される
  await page.locator(`[data-testid="mat-marker"][data-code="${code1}"]`).click();
  await expect(page).toHaveURL(`/mats/${row!.id}`, { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("mat-code")).toHaveText(code1);
  await expect(page.getByTestId("mat-cultivar")).toHaveText("ドワーフナムワ");
  await expect(page.getByTestId("mat-planted-at")).toHaveText("2026-10-05");
  await expect(page.getByTestId("mat-origin-type")).toHaveText("購入吸芽");
  await expect(page.getByTestId("mat-origin")).toHaveText("この位置に植え付け");
  await expect(page.getByTestId("stems-empty")).toHaveText("茎なし");

  // 詳細から地図へ戻れる
  await page.getByTestId("mat-map-link").click();
  await expect(page).toHaveURL(`/fields/${field.id}/map`);
  await expect(page.getByTestId("mat-marker")).toHaveCount(2);
});

test("1b. 品種の既定値は、その圃場で最後に登録した株の品種（品種が 2 つ以上あるときだけ検証）", async ({
  page,
}) => {
  const supabase = await supabaseAsA();
  const { data: cultivars } = await supabase.from("cultivars").select("id, name").order("name");
  const other = (cultivars ?? []).find((c) => c.name !== "ドワーフナムワ");
  test.skip(
    !other,
    "cultivars にドワーフナムワ以外の品種がないので、既定値の切り替えは単体テスト（default-cultivar.test.ts）で担保する",
  );

  const field = await createField("E2E株追加既定品種");
  // 先に別の品種の株を登録しておく
  const { error } = await supabase.from("mats").insert({
    field_id: field.id,
    code: `${field.code}-001`,
    cultivar_id: other!.id,
    lat: CENTER.lat,
    lng: CENTER.lng,
    planted_at: "2026-09-01",
    origin_type: "tissue_culture",
  });
  expect(error).toBeNull();

  const map = await openMap(page, field.id);
  await page.getByRole("button", { name: "1株追加" }).click();
  const c = await canvasCenter(map);
  await page.mouse.click(c.x + 60, c.y + 40);
  await expect(map).toHaveAttribute("data-mode", "single-form");
  await expect(page.getByLabel("品種").locator("option:checked")).toHaveText(other!.name);
});

test("2. 株の詳細に、その株の茎が世代順に表示される", async ({ page }) => {
  const field = await createField("E2E株詳細");
  const matId = await createMat(field.id, `${field.code}-001`);

  // 世代順と逆の順で insert する（表示が insert 順ではなく generation 順であることを確かめる）
  const supabase = await supabaseAsA();
  for (const stem of [
    { generation: 3, status: "sucker", started_at: "2026-09-01" },
    { generation: 2, status: "active", started_at: "2026-06-01", adopted_at: "2026-06-15" },
    { generation: 1, status: "flowered", started_at: "2026-01-10", adopted_at: "2026-01-10" },
  ]) {
    const { error } = await supabase.from("stems").insert({ mat_id: matId, ...stem });
    expect(error).toBeNull();
  }
  // organization_id はトリガーが mats からコピーしている
  const { data: stems } = await supabase.from("stems").select("organization_id").eq("mat_id", matId);
  expect(stems).toHaveLength(3);
  expect(stems!.every((s) => s.organization_id === ORG_A)).toBe(true);

  await page.goto(`/mats/${matId}`);
  await expect(page.getByTestId("mat-code")).toHaveText(`${field.code}-001`);
  await expect(page.getByTestId("mat-cultivar")).toHaveText("ドワーフナムワ");
  await expect(page.getByTestId("mat-planted-at")).toHaveText("2026-09-15");
  await expect(page.getByTestId("mat-origin-type")).toHaveText("組織培養");
  await expect(page.getByTestId("stems-empty")).toHaveCount(0);

  const items = page.getByTestId("stem-item");
  await expect(items).toHaveCount(3);
  const generations = await items.evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset.generation),
  );
  expect(generations).toEqual(["1", "2", "3"]);
  const statuses = await items.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.status));
  expect(statuses).toEqual(["flowered", "active", "sucker"]);
  // 世代と状態の文言
  await expect(items.nth(0)).toContainText("親");
  await expect(items.nth(0)).toContainText("出蕾済み");
  await expect(items.nth(1)).toContainText("子");
  await expect(items.nth(1)).toContainText("栽培中");
  await expect(items.nth(2)).toContainText("孫");
  await expect(items.nth(2)).toContainText("吸芽");
});

test("2b. 茎がなければ「茎なし」と表示される", async ({ page }) => {
  const field = await createField("E2E株詳細茎なし");
  const matId = await createMat(field.id, `${field.code}-001`);

  await page.goto(`/mats/${matId}`);
  await expect(page.getByTestId("mat-code")).toHaveText(`${field.code}-001`);
  await expect(page.getByTestId("stems-empty")).toHaveText("茎なし");
  await expect(page.getByTestId("stem-item")).toHaveCount(0);
  await expect(page.getByTestId("stem-list")).toHaveCount(0);
});

test.describe("他組織", () => {
  test.use({ storageState: AUTH_STATE_B });

  test("テスト農園 B からは A の株の詳細が見えない（404）", async ({ page }) => {
    const field = await createField("E2E株詳細他組織");
    const matId = await createMat(field.id, `${field.code}-001`);
    // B では RLS により行が見えない
    const b = await supabaseAsB();
    const { data } = await b.from("mats").select("id").eq("id", matId);
    expect(data).toEqual([]);

    // notFound() は Suspense 境界の内側で投げるので、HTTP ステータスは（シェルを先に流した）200 のまま。
    // 画面が Not Found になっていること（株の内容が一切出ないこと）で判定する
    await page.goto(`/mats/${matId}`);
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
    await expect(page.getByTestId("mat-code")).toHaveCount(0);
    await expect(page.getByText(`${field.code}-001`)).toHaveCount(0);
  });
});

test.describe("未ログイン", () => {
  test.use({ storageState: noSession });

  test("未ログインで株の詳細を開くと /login に遷移する", async ({ page }) => {
    const field = await createField("E2E株詳細未ログイン");
    const matId = await createMat(field.id, `${field.code}-001`);
    await page.goto(`/mats/${matId}`);
    await expect(page).toHaveURL("/login");
  });
});
