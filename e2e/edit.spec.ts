import type { Locator, Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, randomFieldCode, supabaseAsA, test } from "./helpers";
import { canvasCenter, CENTER, createField, createMat, createStem, dwarfNamwaId, openMap, uniqueName } from "./map-helpers";

// UX-2 圃場・株の編集。完了条件 1〜3 を 1 つずつ検証する（加えて決定事項: 重複の拒否、圃場記号の変更後の採番、
// 入力エラー時に入力値が残る、株分けの株の苗の種類、植え付け日のずれの注意、キャンセル）。
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。テストごとにログインしない。
// 圃場はテストごとに作る（map-helpers の createField。名前は E2E で始め、setup の掃除で消える）。
// 名前を変えるテストも、変更後の名前を E2E で始める（掃除の対象から外れないように）。
// iphone / desktop の 2 プロジェクトが並行して走るので、名前・記号は uniqueName / randomFieldCode で一意にする。

// クライアント遷移では前の画面の DOM が非表示で残る（Next.js）ので、表示中のものに絞る
const visible = (page: Page, testId: string) => page.locator(`[data-testid="${testId}"]:visible`);
const view = (page: Page) => page.locator("main:visible");

const MIN_TAP = 44;

async function expectMinHeight(locator: Locator, min: number) {
  const box = await locator.boundingBox();
  expect(box, `要素が見つかりません: ${locator}`).not.toBeNull();
  expect(box!.height, `高さ ${box!.height}px < ${min}px: ${locator}`).toBeGreaterThanOrEqual(min);
}

async function expectFontSizeAtLeast(locator: Locator, min: number) {
  const size = await locator.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(size, `文字 ${size}px < ${min}px: ${locator}`).toBeGreaterThanOrEqual(min);
}

async function fieldRow(supabase: Awaited<ReturnType<typeof supabaseAsA>>, id: string) {
  const { data, error } = await supabase
    .from("fields")
    .select("name, code, center_lat, center_lng, notes")
    .eq("id", id)
    .single();
  expect(error).toBeNull();
  return data!;
}

async function matRow(id: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("mats")
    .select("code, cultivar_id, planted_at, origin_type, lat, lng, field_id")
    .eq("id", id)
    .single();
  expect(error).toBeNull();
  return data!;
}

// 圃場の詳細 → 「編集」→ 編集画面
async function openFieldEdit(page: Page, fieldId: string) {
  await page.goto(`/fields/${fieldId}`);
  await visible(page, "field-edit-link").click();
  await expect(page).toHaveURL(`/fields/${fieldId}/edit`);
  await expect(page.getByRole("form", { name: "圃場の編集" })).toBeVisible();
}

// 株の詳細 → 「編集」→ 編集画面
async function openMatEdit(page: Page, matId: string) {
  await page.goto(`/mats/${matId}`);
  await visible(page, "mat-edit-link").click();
  await expect(page).toHaveURL(`/mats/${matId}/edit`);
  await expect(page.getByRole("form", { name: "株の編集" })).toBeVisible();
}

// --- 完了条件 1: 圃場の名前を変えると一覧・詳細・地図のヘッダに反映される --------------------------------------------

test("1. 圃場の名前を変えると、一覧・詳細・地図のヘッダに新しい名前が出る（DB も更新される）", async ({ page }) => {
  const field = await createField("E2E編集圃場");
  const before = await fieldRow(field.supabase, field.id);
  const newName = uniqueName("E2E編集後");

  // 先に一覧・詳細・地図を開いておく（ルーターに古い画面が残っていても、保存後に新しい名前が出ることを確かめる）
  await page.goto("/fields");
  await expect(view(page).getByTestId("field-row").filter({ hasText: before.name })).toHaveCount(1);
  await view(page).getByTestId("field-row").filter({ hasText: before.name }).getByRole("link").click();
  await expect(page).toHaveURL(`/fields/${field.id}`);
  await expect(visible(page, "field-detail-name")).toHaveText(before.name);
  await view(page).getByRole("link", { name: "地図（株の配置）" }).click();
  await expect(visible(page, "map-field-name")).toHaveText(`${before.name}（${field.code}）`);
  await visible(page, "back-link").click();
  await expect(page).toHaveURL(`/fields/${field.id}`);

  // 詳細の「編集」→ 名前を変えて保存 → 詳細へ戻る
  await visible(page, "field-edit-link").click();
  await expect(page).toHaveURL(`/fields/${field.id}/edit`);
  const form = page.getByRole("form", { name: "圃場の編集" });
  await expect(form.getByLabel("名前")).toHaveValue(before.name);
  await expect(form.getByLabel("圃場記号")).toHaveValue(field.code);
  await expect(form.getByLabel("緯度")).toHaveValue(String(CENTER.lat));
  await expect(form.getByLabel("経度")).toHaveValue(String(CENTER.lng));
  await form.getByLabel("名前").fill(newName);
  await form.getByLabel("メモ").fill("南側は水はけが悪い");
  await form.getByTestId("field-save").click();

  // 詳細
  await expect(page).toHaveURL(`/fields/${field.id}`, { timeout: ACTION_TIMEOUT });
  await expect(visible(page, "field-detail-name")).toHaveText(newName);
  await expect(visible(page, "field-detail-notes")).toHaveText("南側は水はけが悪い");

  // 地図のヘッダ（詳細から導線で。クライアント遷移）
  await view(page).getByRole("link", { name: "地図（株の配置）" }).click();
  await expect(page).toHaveURL(`/fields/${field.id}/map`);
  await expect(visible(page, "map-field-name")).toHaveText(`${newName}（${field.code}）`);

  // 一覧（下部タブ「設定」。クライアント遷移）: 新しい名前の行が 1 つ、古い名前の行は無い
  await visible(page, "nav-settings").click();
  await expect(page).toHaveURL("/fields");
  await expect(view(page).getByTestId("field-row").filter({ hasText: newName })).toHaveCount(1);
  await expect(view(page).getByTestId("field-row").filter({ hasText: before.name })).toHaveCount(0);

  // 再読み込みしても新しい名前（DB に保存されている）
  await page.reload();
  await expect(view(page).getByTestId("field-row").filter({ hasText: newName })).toHaveCount(1);
  const after = await fieldRow(field.supabase, field.id);
  expect(after.name).toBe(newName);
  expect(after.code).toBe(field.code);
  expect(after.notes).toBe("南側は水はけが悪い");
});

// --- 完了条件 2: 株のコードを変えると株の詳細・地図・茎の画面に反映され、重複するコードは拒否される ----------------

test("2a. 株のコードを変えると、株の詳細・地図の点・茎の画面のヘッダ・最近開いた株に新しいコードが出る", async ({ page }) => {
  const field = await createField("E2E編集株");
  const oldCode = `${field.code}-001`;
  const newCode = `${field.code}-101`;
  const matId = await createMat(field.id, oldCode);
  const stemId = await createStem(matId);

  // 先に茎の画面・株の詳細を開いておく（最近開いた株にも古いコードが残る）
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(oldCode);
  await visible(page, "back-link").click();
  await expect(page).toHaveURL(`/mats/${matId}`);
  await expect(view(page).getByTestId("mat-code")).toHaveText(oldCode);

  // 「編集」→ コードを変えて保存（前後の空白は取り除いて保存する）
  await visible(page, "mat-edit-link").click();
  await expect(page).toHaveURL(`/mats/${matId}/edit`);
  const form = page.getByRole("form", { name: "株の編集" });
  await expect(form.getByLabel("株コード")).toHaveValue(oldCode);
  await form.getByLabel("株コード").fill(`  ${newCode} `);
  await form.getByTestId("mat-save").click();

  // 株の詳細
  await expect(page).toHaveURL(`/mats/${matId}`, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("mat-code")).toHaveText(newCode);
  expect((await matRow(matId)).code).toBe(newCode);

  // 茎の画面のヘッダ（株コード）と「戻る」の表示（クライアント遷移）
  await view(page).getByTestId("stem-link").click();
  await expect(page).toHaveURL(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(newCode);
  await expect(visible(page, "back-link")).toContainText(`株 ${newCode}`);
  await visible(page, "back-link").click();

  // 地図の点（data-code・ラベル）
  await view(page).getByTestId("mat-map-link").click();
  await expect(page).toHaveURL(`/fields/${field.id}/map`);
  await expect(page.getByTestId("field-map")).toHaveAttribute("data-map-ready", "true", { timeout: ACTION_TIMEOUT });
  const marker = page.getByTestId("mat-marker");
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("data-code", newCode);
  await expect(marker).toHaveAttribute("aria-label", `株 ${newCode}`);

  // ホームの「最近開いた株」も新しいコード（古いコードは残らない）
  await visible(page, "home-link").click();
  await expect(page).toHaveURL("/");
  const recent = page.getByTestId("recent-mats");
  await expect(recent.getByTestId("recent-mat-row").filter({ hasText: newCode })).toHaveCount(1);
  await expect(recent.getByText(oldCode, { exact: true })).toHaveCount(0);
});

test("2b. 同じ圃場で重複するコードは拒否され、エラーが出て入力は残り、DB は変わらない", async ({ page }) => {
  const field = await createField("E2E編集重複");
  const code1 = `${field.code}-001`;
  const code2 = `${field.code}-002`;
  await createMat(field.id, code1);
  const mat2 = await createMat(field.id, code2);

  await openMatEdit(page, mat2);
  const form = page.getByRole("form", { name: "株の編集" });
  await form.getByLabel("株コード").fill(code1);
  await form.getByLabel("植え付け日").fill("2026-10-01");
  await form.getByTestId("mat-save").click();

  await expect(form.getByTestId("mat-edit-error")).toHaveText(`この圃場には株コード「${code1}」の株がすでにあります`, {
    timeout: ACTION_TIMEOUT,
  });
  await expect(page).toHaveURL(`/mats/${mat2}/edit`);
  // 入力は消えない（React 19 の送信後のリセットで消えない）
  await expect(form.getByLabel("株コード")).toHaveValue(code1);
  await expect(form.getByLabel("植え付け日")).toHaveValue("2026-10-01");
  // DB は変わらない
  const row = await matRow(mat2);
  expect(row.code).toBe(code2);
  expect(row.planted_at).toBe("2026-09-15");

  // 空（空白だけ）も拒否
  await form.getByLabel("株コード").fill("   ");
  await form.getByTestId("mat-save").click();
  await expect(form.getByTestId("mat-error-code")).toHaveText("株コードを入力してください", { timeout: ACTION_TIMEOUT });
  expect((await matRow(mat2)).code).toBe(code2);

  // 別の圃場に同じコードがあっても拒否しない（一意は圃場内）
  const other = await createField("E2E編集重複別");
  await createMat(other.id, `${field.code}-050`);
  await form.getByLabel("株コード").fill(`${field.code}-050`);
  await form.getByTestId("mat-save").click();
  await expect(page).toHaveURL(`/mats/${mat2}`, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("mat-code")).toHaveText(`${field.code}-050`);
});

test("2c. 株の品種・植え付け日・苗の種類を変えられ、植え付け日が最初の茎とずれたら注意が出る（茎の日付は変えない）", async ({ page }) => {
  const field = await createField("E2E編集株属性");
  const matId = await createMat(field.id, `${field.code}-001`, "2026-09-15");
  const stemId = await createStem(matId, { startedAt: "2026-09-15" });

  await page.goto(`/mats/${matId}`);
  await expect(view(page).getByTestId("mat-code")).toHaveText(`${field.code}-001`);
  await expect(view(page).getByTestId("mat-planted-at-differs")).toHaveCount(0);

  await visible(page, "mat-edit-link").click();
  const form = page.getByRole("form", { name: "株の編集" });
  await expect(form.getByLabel("品種").locator("option:checked")).toHaveText("ドワーフナムワ");
  await expect(form.getByLabel("植え付け日")).toHaveValue("2026-09-15");
  await expect(form.getByLabel("組織培養")).toBeChecked();
  await form.getByLabel("植え付け日").fill("2026-09-20");
  await form.getByLabel("購入吸芽").check();
  await form.getByTestId("mat-save").click();

  await expect(page).toHaveURL(`/mats/${matId}`, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("mat-planted-at")).toHaveText("2026-09-20");
  await expect(view(page).getByTestId("mat-origin-type")).toHaveText("購入吸芽");
  await expect(view(page).getByTestId("mat-planted-at-differs")).toHaveText(
    "株の植え付け日と最初の茎の植え付け日が異なります",
  );

  const row = await matRow(matId);
  expect(row.planted_at).toBe("2026-09-20");
  expect(row.origin_type).toBe("sucker_purchased");
  expect(row.cultivar_id).toBe(await dwarfNamwaId());
  // 位置と圃場は変わらない
  expect(row.field_id).toBe(field.id);
  expect(row.lat).toBe(CENTER.lat);
  expect(row.lng).toBe(CENTER.lng);
  // 茎の started_at / adopted_at は変えない
  const { data: stem } = await field.supabase.from("stems").select("started_at, adopted_at").eq("id", stemId).single();
  expect(stem).toEqual({ started_at: "2026-09-15", adopted_at: "2026-09-15" });
});

test("2d. 株分けで作った株は苗の種類を変えられず理由が出る。コードは変えられ、苗の種類はそのまま", async ({ page }) => {
  const field = await createField("E2E編集株分け");
  const { data, error } = await field.supabase
    .from("mats")
    .insert({
      field_id: field.id,
      code: `${field.code}-001`,
      cultivar_id: await dwarfNamwaId(),
      lat: CENTER.lat,
      lng: CENTER.lng,
      planted_at: "2026-09-15",
      origin_type: "sucker_transplant",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`株を作れません: ${error?.message}`);
  const matId = data.id as string;

  await openMatEdit(page, matId);
  const form = page.getByRole("form", { name: "株の編集" });
  await expect(form.getByTestId("mat-origin-locked")).toContainText("株分け");
  await expect(form.getByTestId("mat-origin-locked")).toContainText("株分けで作った株は、苗の種類を変えられません");
  await expect(form.getByRole("radio")).toHaveCount(0);

  await form.getByLabel("株コード").fill(`${field.code}-009`);
  await form.getByTestId("mat-save").click();
  await expect(page).toHaveURL(`/mats/${matId}`, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("mat-code")).toHaveText(`${field.code}-009`);
  const row = await matRow(matId);
  expect(row.code).toBe(`${field.code}-009`);
  expect(row.origin_type).toBe("sucker_transplant");
});

// --- 決定事項: 圃場記号を変えても既存の株コードは変えず、追加する株は新しい記号で続きの番号 -------------------------

test("圃場記号を変えると注意が出て、既存の株コードは変わらず、次に追加した株は新しい記号で続きの番号になる", async ({ page }) => {
  const field = await createField("E2E編集記号");
  const cultivarId = await dwarfNamwaId();
  // 既存の株 001〜006（南北 2 列、列の間は約 22m。地図は株全体が見えるズームになるので、1株追加で画面の中心をタップしても株と重ならない）
  const oldCodes = [1, 2, 3, 4, 5, 6].map((n) => `${field.code}-${String(n).padStart(3, "0")}`);
  const { error } = await field.supabase.from("mats").insert(
    oldCodes.map((code, i) => ({
      field_id: field.id,
      code,
      cultivar_id: cultivarId,
      lat: CENTER.lat + (i < 3 ? 0.0001 : -0.0001),
      lng: CENTER.lng + (i % 3) * 0.00003,
      planted_at: "2026-09-15",
      origin_type: "tissue_culture",
    })),
  );
  expect(error).toBeNull();

  let newCode = randomFieldCode();
  while (newCode === field.code) newCode = randomFieldCode();

  await openFieldEdit(page, field.id);
  const form = page.getByRole("form", { name: "圃場の編集" });
  // 記号を変えるまでは注意は出ない。変えようとすると出る。元に戻すと消える
  await expect(form.getByTestId("field-code-change-notice")).toHaveCount(0);
  await form.getByLabel("圃場記号").fill(newCode.toLowerCase());
  await expect(form.getByTestId("field-code-change-notice")).toHaveText(
    "既存の株コードは変わりません。新しく追加する株から新しい記号になります",
  );
  await form.getByLabel("圃場記号").fill(field.code);
  await expect(form.getByTestId("field-code-change-notice")).toHaveCount(0);
  await form.getByLabel("圃場記号").fill(newCode.toLowerCase());
  await form.getByTestId("field-save").click();
  await expect(page).toHaveURL(`/fields/${field.id}`, { timeout: ACTION_TIMEOUT });
  await expect(visible(page, "field-detail-code")).toHaveText(newCode);

  // 既存の株コードは変わらない
  const { data: rows } = await field.supabase.from("mats").select("code").eq("field_id", field.id).order("code");
  expect(rows!.map((r) => r.code)).toEqual(oldCodes);

  // 地図で 1 株追加 → 新しい記号で 007
  const map = await openMap(page, field.id);
  await expect(visible(page, "map-field-name")).toContainText(`（${newCode}）`);
  await expect(page.getByTestId("mat-marker")).toHaveCount(6);
  await page.getByRole("button", { name: "1株追加" }).click();
  await expect(map).toHaveAttribute("data-mode", "pick-single");
  const c = await canvasCenter(map);
  await page.mouse.click(c.x, c.y);
  await expect(map).toHaveAttribute("data-mode", "single-form");
  await page.getByTestId("single-confirm").click();
  const added = `${newCode}-007`;
  await expect(page.getByTestId("place-notice")).toContainText(`株 ${added} を追加しました`, { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("mat-marker")).toHaveCount(7);
  const { data: rows2 } = await field.supabase.from("mats").select("code").eq("field_id", field.id).order("code");
  expect(rows2!.map((r) => r.code).sort()).toEqual([...oldCodes, added].sort());
});

// --- 決定事項: 入力エラー時に入力値が残る（圃場）・重複の拒否・キャンセル ----------------------------------------------

test("圃場の編集: 入力エラーや重複のときは保存されず、入力値が残る。キャンセルで詳細に戻り、変更は保存されない", async ({ page }) => {
  const field = await createField("E2E編集エラー");
  const other = await createField("E2E編集エラー別");
  const before = await fieldRow(field.supabase, field.id);
  const otherRow = await fieldRow(field.supabase, other.id);
  const typedName = uniqueName("E2E編集入力");

  await openFieldEdit(page, field.id);
  const form = page.getByRole("form", { name: "圃場の編集" });

  // 緯度の誤り: 項目のエラー。入力した名前・メモ・緯度は残る
  await form.getByLabel("名前").fill(typedName);
  await form.getByLabel("緯度").fill("abc");
  await form.getByLabel("メモ").fill("入力途中のメモ");
  await form.getByTestId("field-save").click();
  await expect(form.getByTestId("field-error-lat")).toHaveText("代表点の緯度を入力してください", {
    timeout: ACTION_TIMEOUT,
  });
  await expect(page).toHaveURL(`/fields/${field.id}/edit`);
  await expect(form.getByLabel("名前")).toHaveValue(typedName);
  await expect(form.getByLabel("緯度")).toHaveValue("abc");
  await expect(form.getByLabel("メモ")).toHaveValue("入力途中のメモ");

  // 記号の形式の誤り（登録と同じ検証。入力欄は maxLength=4 なので 4 文字以内の誤りで確かめる）
  await form.getByLabel("緯度").fill("26.5");
  await form.getByLabel("圃場記号").fill("A-1");
  await form.getByTestId("field-save").click();
  await expect(form.getByTestId("field-error-code")).toHaveText("圃場記号は英数字 1〜4 文字で入力してください", {
    timeout: ACTION_TIMEOUT,
  });
  await expect(form.getByLabel("名前")).toHaveValue(typedName);

  // 同じ組織の別の圃場と同じ名前・記号は DB の unique 制約で拒否され、日本語のエラーが出る
  await form.getByLabel("圃場記号").fill(field.code);
  await form.getByLabel("名前").fill(otherRow.name);
  await form.getByTestId("field-save").click();
  await expect(form.getByTestId("field-error")).toHaveText("同じ名前の圃場がすでにあります", { timeout: ACTION_TIMEOUT });
  await expect(form.getByLabel("名前")).toHaveValue(otherRow.name);
  await form.getByLabel("名前").fill(typedName);
  await form.getByLabel("圃場記号").fill(other.code);
  await form.getByTestId("field-save").click();
  await expect(form.getByTestId("field-error")).toHaveText("同じ圃場記号の圃場がすでにあります", {
    timeout: ACTION_TIMEOUT,
  });
  await expect(form.getByLabel("圃場記号")).toHaveValue(other.code);

  // DB は変わっていない
  expect(await fieldRow(field.supabase, field.id)).toEqual(before);

  // キャンセル → 詳細へ戻り、元の名前のまま
  await form.getByTestId("field-edit-cancel").click();
  await expect(page).toHaveURL(`/fields/${field.id}`);
  await expect(visible(page, "field-detail-name")).toHaveText(before.name);
  expect(await fieldRow(field.supabase, field.id)).toEqual(before);

  // もう一度「編集」（クライアント遷移）: 取り消した入力・前回のエラーは残らず、DB の値から始まる
  await expectFieldEditShowsDb(page, field.id, before);

  // 保存しないまま入力だけ変えてキャンセル → 開き直すと DB の値
  await page.getByRole("form", { name: "圃場の編集" }).getByLabel("名前").fill(uniqueName("E2E取消した名前"));
  await page.getByRole("form", { name: "圃場の編集" }).getByLabel("圃場記号").fill(other.code);
  await expect(page.getByRole("form", { name: "圃場の編集" }).getByTestId("field-code-change-notice")).toBeVisible();
  await page.getByRole("form", { name: "圃場の編集" }).getByTestId("field-edit-cancel").click();
  await expect(page).toHaveURL(`/fields/${field.id}`);
  await expectFieldEditShowsDb(page, field.id, before);

  // 保存してから開き直すと、新しい DB の値から始まる
  const savedName = uniqueName("E2E編集保存後");
  await page.getByRole("form", { name: "圃場の編集" }).getByLabel("名前").fill(savedName);
  await page.getByRole("form", { name: "圃場の編集" }).getByTestId("field-save").click();
  await expect(page).toHaveURL(`/fields/${field.id}`, { timeout: ACTION_TIMEOUT });
  await expect(visible(page, "field-detail-name")).toHaveText(savedName);
  await expectFieldEditShowsDb(page, field.id, { ...before, name: savedName });
});

// 圃場の詳細の「編集」をクライアント遷移で開き、入力欄が DB の値でエラー・注意が無いことを確かめる
async function expectFieldEditShowsDb(
  page: Page,
  fieldId: string,
  db: { name: string; code: string; center_lat: number; center_lng: number; notes: string | null },
) {
  await visible(page, "field-edit-link").click();
  await expect(page).toHaveURL(`/fields/${fieldId}/edit`);
  const form = page.getByRole("form", { name: "圃場の編集" });
  await expect(form.getByLabel("名前")).toHaveValue(db.name);
  await expect(form.getByLabel("圃場記号")).toHaveValue(db.code);
  await expect(form.getByLabel("緯度")).toHaveValue(String(db.center_lat));
  await expect(form.getByLabel("経度")).toHaveValue(String(db.center_lng));
  await expect(form.getByLabel("メモ")).toHaveValue(db.notes ?? "");
  await expect(form.getByRole("alert")).toHaveCount(0);
}

test("株の編集: キャンセルで株の詳細に戻り、変更は保存されない", async ({ page }) => {
  const field = await createField("E2E編集株取消");
  const code = `${field.code}-001`;
  const matId = await createMat(field.id, code);
  await openMatEdit(page, matId);
  const form = page.getByRole("form", { name: "株の編集" });
  await form.getByLabel("株コード").fill(`${field.code}-999`);
  await form.getByTestId("mat-edit-cancel").click();
  await expect(page).toHaveURL(`/mats/${matId}`);
  await expect(view(page).getByTestId("mat-code")).toHaveText(code);
  expect((await matRow(matId)).code).toBe(code);

  // もう一度「編集」（クライアント遷移）: 取り消した値は残らず DB の値
  await expectMatEditShowsDb(page, matId, { code, plantedAt: "2026-09-15", origin: "組織培養" });

  // 重複エラーを出し、苗の種類も選び直してからキャンセル → 開き直すと DB の値で、エラー表示も無い
  const code2 = `${field.code}-002`;
  await createMat(field.id, code2);
  const f = page.getByRole("form", { name: "株の編集" });
  await f.getByLabel("株コード").fill(code2);
  await f.getByLabel("購入吸芽").check();
  await f.getByLabel("植え付け日").fill("2026-10-01");
  await f.getByTestId("mat-save").click();
  await expect(f.getByTestId("mat-edit-error")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await f.getByTestId("mat-edit-cancel").click();
  await expect(page).toHaveURL(`/mats/${matId}`);
  await expectMatEditShowsDb(page, matId, { code, plantedAt: "2026-09-15", origin: "組織培養" });

  // 保存してから開き直すと、新しい DB の値から始まる
  const saved = `${field.code}-003`;
  await f.getByLabel("株コード").fill(saved);
  await f.getByLabel("購入吸芽").check();
  await f.getByTestId("mat-save").click();
  await expect(page).toHaveURL(`/mats/${matId}`, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("mat-code")).toHaveText(saved);
  await expectMatEditShowsDb(page, matId, { code: saved, plantedAt: "2026-09-15", origin: "購入吸芽" });
});

// 株の詳細の「編集」をクライアント遷移で開き、入力欄が DB の値でエラーが無いことを確かめる
async function expectMatEditShowsDb(
  page: Page,
  matId: string,
  db: { code: string; plantedAt: string; origin: "組織培養" | "購入吸芽" },
) {
  await visible(page, "mat-edit-link").click();
  await expect(page).toHaveURL(`/mats/${matId}/edit`);
  const form = page.getByRole("form", { name: "株の編集" });
  await expect(form.getByLabel("株コード")).toHaveValue(db.code);
  await expect(form.getByLabel("植え付け日")).toHaveValue(db.plantedAt);
  await expect(form.getByLabel(db.origin)).toBeChecked();
  await expect(form.getByRole("alert")).toHaveCount(0);
  // カードのタイトル（DB の値）と入力欄が一致している
  await expect(view(page).getByText(db.code, { exact: true })).toBeVisible();
}

// --- 完了条件 3: 編集は UX-1 の部品で作られている ------------------------------------------------------------------

test("3. 編集画面は UX-1 の部品（ヘッダ・下部タブ・同じ高さの入力欄・44px 以上のボタン・16px 以上の文字）で作られている", async ({ page }) => {
  const field = await createField("E2E編集部品");
  const matId = await createMat(field.id, `${field.code}-001`);

  // 圃場の編集
  await openFieldEdit(page, field.id);
  await expect(visible(page, "page-header")).toContainText("圃場を編集");
  await expect(visible(page, "back-link")).toHaveAttribute("href", `/fields/${field.id}`);
  await expect(visible(page, "home-link")).toBeVisible();
  await expect(visible(page, "bottom-nav")).toBeVisible();
  const fieldForm = page.getByRole("form", { name: "圃場の編集" });
  const inputs = fieldForm.locator('[data-slot="input"]:visible');
  await expect(inputs).toHaveCount(4);
  const heights = new Set<number>();
  for (const input of await inputs.all()) {
    await expectMinHeight(input, MIN_TAP);
    await expectFontSizeAtLeast(input, 16);
    heights.add(Math.round((await input.boundingBox())!.height));
  }
  expect(heights.size).toBe(1);
  const inputHeight = [...heights][0];
  await expect(fieldForm.locator('[data-slot="textarea"]')).toHaveCount(1);
  await expectFontSizeAtLeast(fieldForm.locator('[data-slot="textarea"]'), 16);
  await expectMinHeight(fieldForm.getByTestId("field-save"), MIN_TAP);
  await expectMinHeight(fieldForm.getByTestId("field-edit-cancel"), MIN_TAP);
  await expectFontSizeAtLeast(fieldForm.getByTestId("field-save"), 16);
  // 保存ボタンはフォームに 1 つ
  await expect(fieldForm.locator('button[type="submit"]')).toHaveCount(1);

  // 株の編集
  await openMatEdit(page, matId);
  await expect(visible(page, "page-header")).toContainText("株を編集");
  await expect(visible(page, "back-link")).toHaveAttribute("href", `/mats/${matId}`);
  await expect(visible(page, "bottom-nav")).toBeVisible();
  const matForm = page.getByRole("form", { name: "株の編集" });
  for (const input of [matForm.getByLabel("株コード"), matForm.getByLabel("植え付け日"), matForm.getByLabel("品種")]) {
    expect(Math.round((await input.boundingBox())!.height)).toBe(inputHeight);
    await expectFontSizeAtLeast(input, 16);
  }
  for (const t of ["tissue_culture", "sucker_purchased"]) {
    // ラジオは行全体（ラベル）が押せて 44px 以上。ラベルの端を押しても選べる
    const option = matForm.getByTestId(`mat-origin-option-${t}`);
    await expectMinHeight(option, MIN_TAP);
    const box = (await option.boundingBox())!;
    // locator.click は下部タブに隠れていればスクロールしてから押す（iPhone の画面では下部タブの下に来ることがある）
    await option.click({ position: { x: box.width - 4, y: box.height - 3 } });
    await expect(option.getByRole("radio")).toBeChecked();
  }
  await expectMinHeight(matForm.getByTestId("mat-save"), MIN_TAP);
  await expectMinHeight(matForm.getByTestId("mat-edit-cancel"), MIN_TAP);
  await expect(matForm.locator('button[type="submit"]')).toHaveCount(1);

  // 導線（圃場の詳細・株の詳細の「編集」）も 44px 以上
  await page.goto(`/fields/${field.id}`);
  await expectMinHeight(visible(page, "field-edit-link"), MIN_TAP);
  await page.goto(`/mats/${matId}`);
  await expectMinHeight(visible(page, "mat-edit-link"), MIN_TAP);
});
