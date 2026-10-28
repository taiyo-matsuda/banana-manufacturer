import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, AUTH_STATE_B, expect, supabaseAsA, supabaseAsB, test, waitForSynced } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";
import { addDays, eachDate, jstDateOf } from "../src/lib/weather/dates";

// 3-3 収穫予測日（prediction.md 2・7 章）。完了条件 1〜3 を 1 つずつ検証する（計算そのものは src/lib/prediction/harvest.test.ts）。
// テスト農園 A でログイン済み（setup の storageState）。テストごとにログインしない。
// 圃場・株・茎・気温は DB に直接作る（圃場の登録画面を通さないので、登録時の気温の取り込み（モック）は走らない）。
//
// 気温（基準温度は品種の既定 14℃）:
// - 平年値の材料: 2023〜2025 年の全日の日平均 24℃ → 平年値 24℃（10 ℃・日/日）。版は normals-2023-2025
// - 実績: 出蕾（6 日前）の翌日〜昨日の 5 日、日平均 30℃（16 ℃・日/日）→ 実績 80
// 予測（目標 900）: 残り 820 を今日から平年値 10/日 → 82 日目 = 今日 + 81 日。
//   幅: 810 → 残り 730 → 今日 + 72 日、990 → 残り 910 → 今日 + 90 日
// 目標 1000: 残り 920 → 今日 + 91 日（幅 900 → 今日 + 81、1100 → 今日 + 101）

const view = (page: Page) => page.locator("main:visible");
const today = () => jstDateOf(new Date());
const BUD_DAYS_AGO = 6;
const NORMALS_YEARS = [2023, 2024, 2025];

// 期待する表示（実装の整形関数を使わずに組み立てる）
function md(date: string) {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}
function expectedSummary(value: string, lower: string, upper: string) {
  const upperText = lower.slice(0, 7) === upper.slice(0, 7) ? `${Number(upper.slice(8, 10))}日` : md(upper);
  return `収穫予測: ${md(value)}ごろ（${md(lower)}〜${upperText}）`;
}
const EXPECT_900 = () => ({ value: addDays(today(), 81), lower: addDays(today(), 72), upper: addDays(today(), 90) });
const EXPECT_1000 = () => ({ value: addDays(today(), 91), lower: addDays(today(), 81), upper: addDays(today(), 101) });

type EstimateRow = {
  id: string;
  stem_id: string;
  kind: string;
  value_date: string | null;
  lower_date: string | null;
  upper_date: string | null;
  model_version: string;
  inputs: Record<string, unknown>;
  computed_at: string;
  organization_id: string;
};

async function estimates(stemId: string): Promise<EstimateRow[]> {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("estimates")
    .select("id, stem_id, kind, value_date, lower_date, upper_date, model_version, inputs, computed_at, organization_id")
    .eq("stem_id", stemId)
    .order("computed_at");
  if (error) throw new Error(`estimates を読めません: ${error.message}`);
  return (data ?? []) as EstimateRow[];
}

// 平年値の材料（3 年分）と、出蕾の翌日〜昨日の実績（skip の日は入れない）
async function insertWeather(fieldId: string, budDate: string, options: { normals?: boolean; skipActual?: string[] } = {}) {
  const { normals = true, skipActual = [] } = options;
  const supabase = await supabaseAsA();
  const rows: Record<string, unknown>[] = [];
  const row = (date: string, t: number) => ({ field_id: fieldId, date, t_mean: t, t_min: t - 5, t_max: t + 5, api: "archive" });
  if (normals) for (const y of NORMALS_YEARS) for (const date of eachDate(`${y}-01-01`, `${y}-12-31`)) rows.push(row(date, 24));
  for (const date of eachDate(addDays(budDate, 1), addDays(today(), -1))) if (!skipActual.includes(date)) rows.push(row(date, 30));
  // organization_id は渡さない（INSERT トリガーが圃場からコピーする）
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabase.from("weather_daily").insert(rows.slice(i, i + 1000));
    if (error) throw new Error(`weather_daily を入れられません: ${error.message}`);
  }
}

async function setupStem(prefix: string, options: { normals?: boolean; skipActual?: string[] } = {}) {
  const field = await createField(prefix);
  const code = `${field.code}-001`;
  const matId = await createMat(field.id, code, addDays(today(), -150));
  const stemId = await createStem(matId, { startedAt: addDays(today(), -150), initialLeafCount: 5 });
  const budDate = addDays(today(), -BUD_DAYS_AGO);
  await insertWeather(field.id, budDate, options);
  return { field, code, matId, stemId, budDate };
}

// 出蕾を DB に直接記録する（画面からの記録は完了条件 1 で検証する）
async function recordBudDirect(stemId: string, budDate: string) {
  const supabase = await supabaseAsA();
  const { error } = await supabase.rpc("record_stem_event", {
    p_id: crypto.randomUUID(),
    p_stem_id: stemId,
    p_type: "bud_emerged",
    p_occurred_at: `${budDate}T00:00:00+09:00`,
    p_payload: { cumulative_leaves: 30, leaves_current: 12, girth_cm: 50, earliest_at: null },
  });
  if (error) throw new Error(`出蕾を記録できません: ${error.message}`);
}

async function openStem(page: Page, stemId: string, code: string) {
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(code, { timeout: ACTION_TIMEOUT });
}

async function expectHarvest(page: Page, e: { value: string; lower: string; upper: string }) {
  const section = view(page).getByTestId("stem-harvest");
  await expect(section).toHaveAttribute("data-state", "ok", { timeout: ACTION_TIMEOUT });
  await expect(section).toHaveAttribute("data-value-date", e.value);
  await expect(section).toHaveAttribute("data-lower-date", e.lower);
  await expect(section).toHaveAttribute("data-upper-date", e.upper);
  await expect(view(page).getByTestId("stem-harvest-summary")).toHaveText(expectedSummary(e.value, e.lower, e.upper));
}

// 茎の画面の「被害」で記録する（outbox → 同期）
async function recordStemDamage(page: Page, severity: "severe" | "lost") {
  await view(page).getByTestId("event-button-damage").click();
  const dialog = page.getByTestId("event-dialog");
  await expect(dialog).toHaveAttribute("data-type", "damage");
  await dialog.getByTestId("event-kind").selectOption("lodging");
  await dialog.getByTestId("event-severity").selectOption(severity);
  await dialog.getByTestId("event-submit").click();
  await expect(page.getByTestId("event-dialog")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
}

test("完了条件 1: 出蕾を記録すると、茎の画面に予測日と幅が出る。estimates に model_version と inputs 付きで追記される（上書きしない）", async ({
  page,
}) => {
  const { code, matId, stemId, budDate } = await setupStem("E2E収穫予測");
  const earliest = addDays(budDate, -3);
  await openStem(page, stemId, code);
  // 出蕾前は収穫予測を出さない
  await expect(view(page).getByTestId("stem-harvest")).toHaveCount(0);
  expect(await estimates(stemId)).toEqual([]);

  // 画面から出蕾を記録（確認日 6 日前、前回訪問日 9 日前）
  await view(page).getByTestId("event-button-bud_emerged").click();
  const dialog = page.getByTestId("event-dialog");
  await dialog.getByTestId("event-date").fill(budDate);
  await dialog.getByTestId("event-earliest-at").fill(earliest);
  await dialog.getByTestId("event-leaves-current").fill("12");
  await dialog.getByTestId("event-girth-cm").fill("50");
  await dialog.getByTestId("event-submit").click();
  await expect(view(page).getByTestId("event-notice")).toHaveText("出蕾を記録しました", { timeout: ACTION_TIMEOUT });
  await waitForSynced(page);

  // 同期の後の再描画で、茎の画面に「収穫予測: ◯月◯日ごろ（◯日〜◯日）」が出る（再読み込みしなくても）
  await expectHarvest(page, EXPECT_900());
  await expect(view(page).getByTestId("stem-harvest-review")).toHaveCount(0);

  // estimates: 1 行。model_version と inputs（出蕾日・前回訪問日・目標 GDD・実績 GDD・平年値の版）
  const rows = await estimates(stemId);
  expect(rows).toHaveLength(1);
  const e = EXPECT_900();
  expect(rows[0]).toMatchObject({
    kind: "harvest_date",
    value_date: e.value,
    lower_date: e.lower,
    upper_date: e.upper,
    model_version: "harvest-gdd-v1",
    organization_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  expect(rows[0].inputs).toMatchObject({
    bud_date: budDate,
    earliest_at: earliest,
    target_gdd: 900,
    target_gdd_source: "cultivar",
    base_temp_c: 14,
    actual_from: addDays(budDate, 1),
    actual_to: addDays(today(), -1),
    actual_gdd: 80,
    actual_days: 5,
    actual_missing_days: 0,
    normals_version: "normals-2023-2025",
    range_ratio: 0.1,
    damage: null,
  });

  // 開き直しても同じ入力なら追記しない（行が増えない）。株の詳細の茎一覧にも予測日
  await page.reload();
  await expectHarvest(page, EXPECT_900());
  expect(await estimates(stemId)).toHaveLength(1);
  await page.goto(`/mats/${matId}`);
  const item = view(page).locator(`[data-testid="stem-item"][data-stem-id="${stemId}"]`);
  await expect(item.getByTestId("stem-harvest-date")).toHaveText(`収穫予測 ${md(e.value)}ごろ`, { timeout: ACTION_TIMEOUT });
  await expect(item.getByTestId("stem-harvest-date")).toHaveAttribute("data-value-date", e.value);

  // 推定は追記のみ: アプリの権限では更新も削除もできない（0021。0 行で、値はそのまま）
  const supabase = await supabaseAsA();
  const { data: updated } = await supabase.from("estimates").update({ value_date: today() }).eq("id", rows[0].id).select("id");
  expect(updated ?? []).toEqual([]);
  const { data: deleted } = await supabase.from("estimates").delete().eq("id", rows[0].id).select("id");
  expect(deleted ?? []).toEqual([]);
  expect((await estimates(stemId))[0]).toMatchObject({ id: rows[0].id, value_date: e.value });
});

test("完了条件 2: 目標 GDD を変えると、再計算で予測日が変わり、古い推定も残っている", async ({ page }) => {
  const { field, code, stemId, budDate } = await setupStem("E2E目標積算");
  await recordBudDirect(stemId, budDate);
  // 出蕾は RPC で直接入れた（再計算の呼び出しが無い）。茎の画面を開くと推定の無い出蕾済みの茎は 1 回計算して追記する
  await openStem(page, stemId, code);
  await expectHarvest(page, EXPECT_900());
  const before = await estimates(stemId);
  expect(before).toHaveLength(1);

  // 圃場の詳細の「予測の設定」で目標積算温度を 1000 にする → 保存の後に再計算
  await page.goto(`/fields/${field.id}`);
  const form = page.getByTestId("prediction-params-form").filter({ hasText: "ドワーフナムワ" });
  await expect(form).toBeVisible({ timeout: ACTION_TIMEOUT });
  await form.getByTestId("prediction-target-gdd").fill("1000");
  await form.getByTestId("prediction-save").click();
  await expect(form.getByTestId("prediction-saved")).toHaveText("保存しました", { timeout: ACTION_TIMEOUT });

  // 推定が追記されている（古い推定は残り、中身も変わっていない）
  const after = await estimates(stemId);
  expect(after).toHaveLength(2);
  expect(after[0]).toMatchObject({ id: before[0].id, value_date: EXPECT_900().value });
  expect(after[0].inputs).toMatchObject({ target_gdd: 900, target_gdd_source: "cultivar" });
  const e = EXPECT_1000();
  expect(after[1]).toMatchObject({ value_date: e.value, lower_date: e.lower, upper_date: e.upper, model_version: "harvest-gdd-v1" });
  expect(after[1].inputs).toMatchObject({ target_gdd: 1000, target_gdd_source: "field", actual_gdd: 80 });
  expect(after[1].computed_at > after[0].computed_at).toBe(true);

  // 茎の画面は最新の推定
  await openStem(page, stemId, code);
  await expectHarvest(page, e);
});

test("日次の気温取り込み（Cron）の後に再計算され、取り込んだ実績で予測が追記される", async ({ page, request }) => {
  // 昨日の実績が欠けた状態で出蕾 → 欠けた日は平年値（10）で補う: 実績 64 + 10 → 残り 826 → 83 日目 = 今日 + 82
  const yesterday = addDays(today(), -1);
  const { field, code, stemId, budDate } = await setupStem("E2E予測Cron", { skipActual: [yesterday] });
  await recordBudDirect(stemId, budDate);
  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("stem-harvest")).toHaveAttribute("data-value-date", addDays(today(), 82), {
    timeout: ACTION_TIMEOUT,
  });
  expect((await estimates(stemId))[0].inputs).toMatchObject({ actual_gdd: 64, actual_missing_days: 1 });

  // 昨日の気温が入った後、日次の取り込み（Cron）を走らせる。モックの API はすべて失敗させ、気温は上で入れた値だけにする
  const supabase = await supabaseAsA();
  const { error } = await supabase
    .from("weather_daily")
    .insert({ field_id: field.id, date: yesterday, t_mean: 30, t_min: 25, t_max: 35, api: "archive" });
  expect(error).toBeNull();
  const res = await request.get(`/api/cron/weather?fieldId=${field.id}`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "e2e-weather-fault": "all" },
    timeout: 60_000,
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.predictions).toEqual([expect.objectContaining({ fieldId: field.id, stems: 1, inserted: 1, errors: [] })]);

  const rows = await estimates(stemId);
  expect(rows).toHaveLength(2);
  expect(rows[1].inputs).toMatchObject({ actual_gdd: 80, actual_missing_days: 0 });
  expect(rows[1].value_date).toBe(EXPECT_900().value);
  await openStem(page, stemId, code);
  await expectHarvest(page, EXPECT_900());

  // もう一度走らせても入力が同じなら追記しない
  const again = await request.get(`/api/cron/weather?fieldId=${field.id}`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "e2e-weather-fault": "all" },
    timeout: 60_000,
  });
  expect((await again.json()).predictions[0]).toMatchObject({ inserted: 0, unchanged: 1 });
  expect(await estimates(stemId)).toHaveLength(2);
});

test("完了条件 3a: 茎に severe の被害を記録すると「要確認」（予測日は出たまま）。株の詳細の茎一覧にも要確認", async ({ page }) => {
  const { code, matId, stemId, budDate } = await setupStem("E2E予測被害");
  await recordBudDirect(stemId, budDate);
  await openStem(page, stemId, code);
  await expectHarvest(page, EXPECT_900());
  await expect(view(page).getByTestId("stem-harvest")).toHaveAttribute("data-needs-review", "false");

  await recordStemDamage(page, "severe");
  await waitForSynced(page);
  const section = view(page).getByTestId("stem-harvest");
  await expect(section).toHaveAttribute("data-needs-review", "true", { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-harvest-review")).toHaveText("要確認");
  await expectHarvest(page, EXPECT_900());

  const rows = await estimates(stemId);
  expect(rows).toHaveLength(2);
  expect(rows[0].inputs.damage).toBeNull();
  expect(rows[1].inputs).toMatchObject({ damage: "severe" });
  expect(rows[1].inputs.damage_events).toEqual([expect.objectContaining({ target_type: "stem", date: today() })]);

  await page.goto(`/mats/${matId}`);
  const item = view(page).locator(`[data-testid="stem-item"][data-stem-id="${stemId}"]`);
  await expect(item.getByTestId("stem-harvest-review")).toHaveText("要確認", { timeout: ACTION_TIMEOUT });
  await expect(item.getByTestId("stem-harvest-date")).toHaveAttribute("data-value-date", EXPECT_900().value);
});

test("完了条件 3b: 圃場に severe の被害を記録すると、その圃場の出蕾済みの茎が「要確認」になる", async ({ page }) => {
  const { field, code, stemId, budDate } = await setupStem("E2E予測圃場被害");
  await recordBudDirect(stemId, budDate);
  await openStem(page, stemId, code);
  await expectHarvest(page, EXPECT_900());
  await expect(view(page).getByTestId("stem-harvest-review")).toHaveCount(0);

  // 圃場の詳細の「被害を記録」（2-5）: 倒伏・重
  await page.goto(`/fields/${field.id}`);
  await expect(page.getByTestId("field-detail-name")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await page.getByTestId("damage-open").click();
  await page.getByTestId("damage-kind").selectOption("lodging");
  await page.getByTestId("damage-severity").selectOption("severe");
  await page.getByTestId("damage-submit").click();
  await expect(page.getByTestId("damage-done")).toBeVisible({ timeout: ACTION_TIMEOUT });

  const rows = await estimates(stemId);
  expect(rows).toHaveLength(2);
  expect(rows[1].inputs).toMatchObject({ damage: "severe" });
  expect(rows[1].inputs.damage_events).toEqual([expect.objectContaining({ target_type: "field", date: today() })]);

  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("stem-harvest")).toHaveAttribute("data-needs-review", "true");
  await expect(view(page).getByTestId("stem-harvest-review")).toHaveText("要確認");
  await expectHarvest(page, EXPECT_900());
});

test("完了条件 3c: 茎を喪失（lost）にすると予測が出ず、推定も追記されない", async ({ page }) => {
  const { code, matId, stemId, budDate } = await setupStem("E2E予測喪失");
  await recordBudDirect(stemId, budDate);
  await openStem(page, stemId, code);
  await expectHarvest(page, EXPECT_900());

  await recordStemDamage(page, "lost");
  await expect(view(page).getByTestId("stem-status")).toHaveText("喪失", { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-harvest")).toHaveCount(0);
  await waitForSynced(page);

  await page.reload();
  await expect(view(page).getByTestId("stem-status")).toHaveText("喪失", { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-harvest")).toHaveCount(0);
  await expect(page.getByText("収穫予測")).toHaveCount(0);
  // 喪失の後に推定は追記されない（出蕾のときの 1 行だけ。古い推定は消さない）
  expect(await estimates(stemId)).toHaveLength(1);

  await page.goto(`/mats/${matId}`);
  const item = view(page).locator(`[data-testid="stem-item"][data-stem-id="${stemId}"]`);
  await expect(item).toHaveAttribute("data-status", "lost", { timeout: ACTION_TIMEOUT });
  await expect(item.getByTestId("stem-harvest-date")).toHaveCount(0);
});

test("平年値の材料が無い圃場では予測日を出さず、理由を出す", async ({ page }) => {
  const { code, stemId, budDate } = await setupStem("E2E予測平年値なし", { normals: false });
  await recordBudDirect(stemId, budDate);
  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("stem-harvest")).toHaveAttribute("data-state", "unavailable", { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-harvest-unavailable")).toHaveText(
    "平年値の材料（過去の気温）がまだ取り込まれていないため、収穫予測を出せません",
  );
  await expect(view(page).getByTestId("stem-harvest-summary")).toHaveCount(0);
  const rows = await estimates(stemId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ value_date: null, lower_date: null, upper_date: null });
  expect(rows[0].inputs).toMatchObject({ unavailable_reason: "no_normals", normals_version: null });
});

test.describe("他組織", () => {
  test.use({ storageState: AUTH_STATE_B });

  test("テスト農園 B からは A の推定が見えず、書けず、再計算もできない", async ({ page }) => {
    const { stemId, budDate } = await setupStem("E2E予測他組織");
    await recordBudDirect(stemId, budDate);
    const a = await supabaseAsA();
    const b = await supabaseAsB();
    expect(await estimates(stemId)).toEqual([]);

    // B の権限で再計算を呼んでも A の茎は見えない（何もしない）
    const res = await page.request.post("/api/predictions/recompute", { data: { stemId } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, stems: 0, inserted: 0 });
    expect(await estimates(stemId)).toEqual([]);

    // A の推定を 1 行（このテストのページは B のセッションなので、A のクライアントで直接入れる）
    const { error: aError } = await a.from("estimates").insert({
      stem_id: stemId,
      kind: "harvest_date",
      value_date: addDays(today(), 80),
      lower_date: addDays(today(), 70),
      upper_date: addDays(today(), 90),
      model_version: "harvest-gdd-v1",
      inputs: { bud_date: budDate },
    });
    expect(aError).toBeNull();

    // 見えない（estimates も latest_estimates も）
    const { data: seen } = await b.from("estimates").select("id").eq("stem_id", stemId);
    expect(seen).toEqual([]);
    const { data: latest } = await b.from("latest_estimates").select("stem_id").eq("stem_id", stemId);
    expect(latest).toEqual([]);
    // 書けない
    const { error: insertError } = await b.from("estimates").insert({
      stem_id: stemId,
      kind: "harvest_date",
      value_date: today(),
      model_version: "x",
    });
    expect(insertError).not.toBeNull();
    expect(await estimates(stemId)).toHaveLength(1);

    // 画面: A の茎は 404
    await page.goto(`/stems/${stemId}`);
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible({ timeout: ACTION_TIMEOUT });
    await expect(page.getByTestId("stem-harvest")).toHaveCount(0);
  });
});
