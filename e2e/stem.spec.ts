import type { Locator, Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, supabaseAsA, test } from "./helpers";
import { canvasCenter, createField, createMat, createStem, openMap } from "./map-helpers";

// 1-5 茎の登録（植え付け）。完了条件 1〜2 を 1 つずつ検証する。
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。テストごとにログインしない。
// テストが作る圃場の名前は E2E で始める（setup の掃除で圃場・株・茎ごと消える）。

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function stemRows(matId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("stems")
    .select("id, generation, parent_stem_id, status, started_at, adopted_at, initial_leaf_count, organization_id")
    .eq("mat_id", matId)
    .order("generation");
  if (error) throw new Error(`茎を取得できません: ${error.message}`);
  return data!;
}

// 栽培中の茎を DB に直接作る（UI を通さない経路。トリガー経由のエラーの再現や前提作りに使う）
const insertActiveStem = (matId: string, generation: number, parentStemId: string | null = null) =>
  createStem(matId, { generation, parentStemId });

// 株の詳細で「茎を登録」を開き、初期葉数を入れて送信する（植え付け日は既定のまま）
async function openStemForm(page: Page) {
  await page.getByTestId("stem-add").click();
  await expect(page.getByTestId("stem-form")).toBeVisible();
}

async function submitStem(page: Page, initialLeafCount: string, plantedAt?: string) {
  if (plantedAt !== undefined) await page.getByLabel("植え付け日").fill(plantedAt);
  await page.getByLabel("初期葉数").fill(initialLeafCount);
  await page.getByTestId("stem-submit").click();
}

async function cumulativeLeavesShown(items: Locator) {
  return items.evaluateAll((els) =>
    els.map((e) => e.querySelector('[data-testid="stem-cumulative-leaves"]')?.textContent?.trim()),
  );
}

test("1. 茎を登録すると株の詳細に表示され、累計葉数 = 初期葉数 になっている", async ({ page }) => {
  const field = await createField("E2E茎登録");
  const matId = await createMat(field.id, `${field.code}-001`, "2026-09-15");

  await page.goto(`/mats/${matId}`);
  await expect(page.getByTestId("mat-code")).toHaveText(`${field.code}-001`);
  await expect(page.getByTestId("stems-empty")).toHaveText("茎なし");

  // 「茎を登録」→ フォーム。植え付け日の既定はその株の植え付け日。最初の茎なので「親」
  await openStemForm(page);
  await expect(page.getByTestId("stem-form")).toContainText("最初の茎（親）を登録");
  await expect(page.getByLabel("植え付け日")).toHaveValue("2026-09-15");
  await submitStem(page, "4");

  // 登録後: フォームが閉じ、一覧に親（第 1 世代・栽培中）が出て、累計葉数 = 初期葉数（4）
  await expect(page.getByTestId("stem-notice")).toHaveText("茎を登録しました", { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("stems-empty")).toHaveCount(0);
  const items = page.getByTestId("stem-item");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveAttribute("data-generation", "1");
  await expect(items.first()).toHaveAttribute("data-status", "active");
  await expect(items.first()).toContainText("親");
  await expect(items.first().getByTestId("stem-status")).toHaveText("栽培中");
  await expect(items.first().getByTestId("stem-cumulative-leaves")).toHaveText("4");

  // DB: generation=1、status=active、started_at=adopted_at=植え付け日、initial_leaf_count=4。
  // organization_id はトリガーが mats からコピー（アプリは渡していない）
  const rows = await stemRows(matId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    generation: 1,
    parent_stem_id: null,
    status: "active",
    started_at: "2026-09-15",
    adopted_at: "2026-09-15",
    initial_leaf_count: 4,
    organization_id: ORG_A,
  });
  await expect(items.first()).toHaveAttribute("data-stem-id", rows[0].id);

  // 再読み込み後も表示され、累計葉数は 4 のまま
  await page.reload();
  await expect(page.getByTestId("stem-item")).toHaveCount(1);
  await expect(page.getByTestId("stem-cumulative-leaves")).toHaveText("4");
  // 2 本目（子）を登録するときは第 2 世代として案内される
  await openStemForm(page);
  await expect(page.getByTestId("stem-form")).toContainText("第 2 世代の茎を登録");
});

test("1b. 初期葉数が空・負数なら登録できず、理由が表示される", async ({ page }) => {
  const field = await createField("E2E茎登録検証");
  const matId = await createMat(field.id, `${field.code}-001`);

  await page.goto(`/mats/${matId}`);
  await openStemForm(page);
  // 空
  await page.getByTestId("stem-submit").click();
  await expect(page.getByTestId("stem-error-initialLeafCount")).toHaveText("初期葉数を入力してください", {
    timeout: ACTION_TIMEOUT,
  });
  await expect(page.getByTestId("stem-item")).toHaveCount(0);
  // 負数
  await submitStem(page, "-1");
  await expect(page.getByTestId("stem-error-initialLeafCount")).toHaveText(
    "初期葉数は 0 以上の整数で入力してください",
    { timeout: ACTION_TIMEOUT },
  );
  await expect(page.getByTestId("stem-item")).toHaveCount(0);
  // 植え付け日が空
  await submitStem(page, "3", "");
  await expect(page.getByTestId("stem-error-plantedAt")).toContainText("植え付け日", { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("stem-item")).toHaveCount(0);
  expect(await stemRows(matId)).toHaveLength(0);

  // 0 は登録できる（累計葉数 0）
  await submitStem(page, "0", "2026-09-20");
  await expect(page.getByTestId("stem-notice")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("stem-cumulative-leaves")).toHaveText("0");
  const rows = await stemRows(matId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ initial_leaf_count: 0, started_at: "2026-09-20", adopted_at: "2026-09-20" });
});

test("2. 3 本目まで登録でき、4 本目は「茎を登録」が出ず理由が表示される（登録されない）", async ({ page }) => {
  const field = await createField("E2E茎上限");
  const matId = await createMat(field.id, `${field.code}-001`);
  // 親・子は DB に直接作る
  const parent = await insertActiveStem(matId, 1);
  const child = await insertActiveStem(matId, 2, parent);

  await page.goto(`/mats/${matId}`);
  await expect(page.getByTestId("stem-item")).toHaveCount(2);
  await expect(page.getByTestId("stem-add")).toBeVisible();

  // 3 本目（孫）を UI で登録: generation = 3、parent_stem_id = 子
  await openStemForm(page);
  await expect(page.getByTestId("stem-form")).toContainText("第 3 世代の茎を登録");
  await submitStem(page, "5");
  await expect(page.getByTestId("stem-item")).toHaveCount(3, { timeout: ACTION_TIMEOUT });
  const items = page.getByTestId("stem-item");
  await expect(items.nth(2)).toHaveAttribute("data-generation", "3");
  await expect(items.nth(2)).toContainText("孫");
  expect(await cumulativeLeavesShown(items)).toEqual(["2", "2", "5"]);
  let rows = await stemRows(matId);
  expect(rows).toHaveLength(3);
  expect(rows[2]).toMatchObject({ generation: 3, parent_stem_id: child, status: "active", initial_leaf_count: 5 });

  // 4 本目: 栽培中が 3 本なので「茎を登録」は出ず、理由が表示される（再読み込み後も）
  await expect(page.getByTestId("stem-add")).toHaveCount(0);
  await expect(page.getByTestId("stem-form")).toHaveCount(0);
  await expect(page.getByTestId("stem-add-blocked")).toContainText("栽培中の茎が 3 本");
  await page.reload();
  await expect(page.getByTestId("stem-item")).toHaveCount(3);
  await expect(page.getByTestId("stem-add")).toHaveCount(0);
  await expect(page.getByTestId("stem-add-blocked")).toContainText("これ以上は登録できません");
  rows = await stemRows(matId);
  expect(rows).toHaveLength(3);

  // DB の正本: 直接 4 本目を insert してもトリガーが拒否する
  const supabase = await supabaseAsA();
  const { error } = await supabase.from("stems").insert({
    mat_id: matId,
    generation: 4,
    status: "active",
    started_at: "2026-09-15",
    adopted_at: "2026-09-15",
  });
  expect(error?.message).toContain("already has 3 active stems");
  expect(await stemRows(matId)).toHaveLength(3);
});

test("2b. フォームを開いた後に別経路で 3 本になっていたら、送信時に DB トリガーのエラーが日本語で表示され登録されない", async ({
  page,
}) => {
  const field = await createField("E2E茎上限トリガー");
  const matId = await createMat(field.id, `${field.code}-001`);
  const parent = await insertActiveStem(matId, 1);
  const child = await insertActiveStem(matId, 2, parent);

  // 2 本の状態で画面を開き、フォームも開く（この時点ではアプリの事前判定は通る）
  await page.goto(`/mats/${matId}`);
  await expect(page.getByTestId("stem-item")).toHaveCount(2);
  await openStemForm(page);

  // 別経路（他の端末など）で 3 本目が入る
  await insertActiveStem(matId, 3, child);
  expect(await stemRows(matId)).toHaveLength(3);

  // 送信 → Server Action で再度数えて断る（または DB トリガーが拒否）。いずれも日本語のエラーが画面に出る
  await submitStem(page, "3");
  const error = page.getByTestId("stem-error");
  await expect(error).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(error).toContainText("3 本");
  await expect(error).toContainText("登録できません");
  // 登録されていない（3 本のまま）
  const rows = await stemRows(matId);
  expect(rows).toHaveLength(3);
  expect(rows.map((r) => r.initial_leaf_count)).toEqual([2, 2, 2]);
});

test("2c. 収穫済みの茎は本数に数えない（active/flowered 以外が何本あっても登録できる）", async ({ page }) => {
  const field = await createField("E2E茎上限収穫済み");
  const matId = await createMat(field.id, `${field.code}-001`);
  const supabase = await supabaseAsA();
  for (const [generation, status] of [
    [1, "harvested"],
    [2, "flowered"],
    [3, "active"],
  ] as const) {
    const { error } = await supabase.from("stems").insert({
      mat_id: matId,
      generation,
      status,
      started_at: "2026-09-15",
      adopted_at: "2026-09-15",
      initial_leaf_count: 1,
    });
    expect(error).toBeNull();
  }

  await page.goto(`/mats/${matId}`);
  await expect(page.getByTestId("stem-item")).toHaveCount(3);
  // 栽培中は 2 本（flowered + active）なので登録できる
  await expect(page.getByTestId("stem-add")).toBeVisible();
  await openStemForm(page);
  await expect(page.getByTestId("stem-form")).toContainText("第 4 世代の茎を登録");
  await submitStem(page, "1");
  await expect(page.getByTestId("stem-item")).toHaveCount(4, { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("stem-add")).toHaveCount(0);
  await expect(page.getByTestId("stem-add-blocked")).toBeVisible();
  expect(await stemRows(matId)).toHaveLength(4);
});

// 一括登録（要件 UC-1「一括で同じ値を入れ、例外だけ直す」）: 配置・1株追加のフォームに初期葉数を入れると、
// 株と同時に最初の茎（generation=1、active、started_at=adopted_at=植え付け日）も作られる
test.describe("株の配置で初期葉数を入れると最初の茎も登録される", () => {
  test("1株追加: 初期葉数あり → 茎あり。省略 → 茎なし", async ({ page }) => {
    const field = await createField("E2E茎一括追加");
    const map = await openMap(page, field.id);
    const c = await canvasCenter(map);

    // 初期葉数 3 で 1 株追加
    await page.getByRole("button", { name: "1株追加" }).click();
    await page.mouse.click(c.x, c.y);
    await expect(map).toHaveAttribute("data-mode", "single-form");
    await page.getByLabel("植え付け日").fill("2026-10-05");
    await page.getByLabel("初期葉数").fill("3");
    await page.getByTestId("single-confirm").click();
    const code1 = `${field.code}-001`;
    await expect(page.getByTestId("place-notice")).toContainText(`株 ${code1} を追加しました`, {
      timeout: ACTION_TIMEOUT,
    });

    const { data: mat1 } = await field.supabase.from("mats").select("id").eq("code", code1).single();
    const rows1 = await stemRows(mat1!.id);
    expect(rows1).toHaveLength(1);
    expect(rows1[0]).toMatchObject({
      generation: 1,
      parent_stem_id: null,
      status: "active",
      started_at: "2026-10-05",
      adopted_at: "2026-10-05",
      initial_leaf_count: 3,
      organization_id: ORG_A,
    });

    // 初期葉数を空にして 1 株追加 → 茎は作られない（フォームの値は前回の入力を保つので明示的に消す）
    await page.getByRole("button", { name: "1株追加" }).click();
    await page.mouse.click(c.x + 60, c.y + 40);
    await expect(map).toHaveAttribute("data-mode", "single-form");
    await expect(page.getByLabel("初期葉数")).toHaveValue("3");
    await page.getByLabel("初期葉数").fill("");
    await page.getByTestId("single-confirm").click();
    const code2 = `${field.code}-002`;
    await expect(page.getByTestId("place-notice")).toContainText(`株 ${code2} を追加しました`, {
      timeout: ACTION_TIMEOUT,
    });
    const { data: mat2 } = await field.supabase.from("mats").select("id").eq("code", code2).single();
    expect(await stemRows(mat2!.id)).toHaveLength(0);

    // 株の詳細: 1 株目は累計葉数 3、2 株目は「茎なし」
    await page.locator(`[data-testid="mat-marker"][data-code="${code1}"]`).click();
    await expect(page).toHaveURL(`/mats/${mat1!.id}`, { timeout: ACTION_TIMEOUT });
    await expect(page.getByTestId("stem-item")).toHaveCount(1);
    await expect(page.getByTestId("stem-cumulative-leaves")).toHaveText("3");
    await page.goto(`/mats/${mat2!.id}`);
    await expect(page.getByTestId("stems-empty")).toHaveText("茎なし");
  });

  test("1株追加: 初期葉数が不正なら確定できず、株も茎も作られない", async ({ page }) => {
    const field = await createField("E2E茎一括検証");
    const map = await openMap(page, field.id);
    const c = await canvasCenter(map);
    await page.getByRole("button", { name: "1株追加" }).click();
    await page.mouse.click(c.x, c.y);
    await expect(map).toHaveAttribute("data-mode", "single-form");
    await page.getByLabel("初期葉数").fill("-2");
    await page.getByTestId("single-confirm").click();
    await expect(page.getByTestId("place-error")).toHaveText("初期葉数は 0 以上の整数で入力してください");
    const { data: mats } = await field.supabase.from("mats").select("id").eq("field_id", field.id);
    expect(mats).toEqual([]);
  });

  test("格子で配置: 1列 × 2本に初期葉数 2 を入れると、2 株とも茎が作られる", async ({ page }) => {
    const field = await createField("E2E茎一括格子");
    const map = await openMap(page, field.id);
    await page.getByRole("button", { name: "配置を始める" }).click();
    const c = await canvasCenter(map);
    await page.mouse.click(c.x, c.y);
    await expect(page.getByTestId("place-status")).toContainText("2 点目");
    await page.mouse.click(c.x + 80, c.y);
    await expect(page.getByTestId("guide-marker-direction")).toHaveCount(1);
    await page.getByLabel("列数").fill("1");
    await page.getByLabel("1列の本数").fill("2");
    await page.getByLabel("植え付け日").fill("2026-10-01");
    await page.getByLabel("初期葉数").fill("2");
    await page.getByRole("button", { name: "プレビュー" }).click();
    await expect(page.getByTestId("preview-marker")).toHaveCount(2);
    await page.getByTestId("place-confirm").click();
    await expect(page.getByTestId("place-notice")).toContainText("2 株を保存しました", {
      timeout: ACTION_TIMEOUT,
    });
    await expect(page.getByTestId("mat-marker")).toHaveCount(2);

    const { data: mats } = await field.supabase
      .from("mats")
      .select("id, code")
      .eq("field_id", field.id)
      .order("code");
    expect(mats).toHaveLength(2);
    for (const m of mats!) {
      const rows = await stemRows(m.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        generation: 1,
        status: "active",
        started_at: "2026-10-01",
        adopted_at: "2026-10-01",
        initial_leaf_count: 2,
      });
    }
  });
});
