import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, AUTH_STATE_B, expect, supabaseAsA, supabaseAsB, test } from "./helpers";
import { createField, createMat, createStem, dwarfNamwaId } from "./map-helpers";
import { addDays, jstDateOf } from "../src/lib/weather/dates";

// 3-2 積算温度と平年値（prediction.md 1 章）。完了条件 2・3 を 1 つずつ検証する（1 は src/lib/gdd.test.ts の単体テスト）。
// テスト農園 A でログイン済み（setup の storageState）。テストごとにログインしない。
// 圃場・株・茎・気温は DB に直接作る（圃場の登録画面を通さないので、登録時の気温の取り込み（モック）は走らない）。
// 気温は既知の値を weather_daily / weather_hourly に入れ、画面の数値が手計算と一致することを確かめる。
//
// 積算の期間は「出蕾日の翌日〜昨日」（今日の日次はまだ取り込まれない）。出蕾日と今日の行も入れて、数えないことを確かめる。
// 出蕾は 6 日前。d1〜d5 = 出蕾の 1〜5 日後（d5 = 昨日）。
//   d1: 日平均 20    → 基準 14: 6     / 基準 12: 8
//   d2: 日平均 24.4  → 10.4          / 12.4
//   d3: 日平均 15、時間別 24 時間（前半 12 時間 10℃・後半 12 時間 20℃）
//                    → 時間別で (0×12 + 6×12)/24 = 3（日平均なら 1） / (0×12 + 8×12)/24 = 4
//   d4: 日平均 13    → 0（基準未満）  / 1
//   d5: 日平均 25.6  → 11.6          / 13.6
//   合計             → 31             / 39
// 出蕾日（日平均 35）と今日（日平均 35）は数えない（数えると 21 ずつ増える）

const today = () => jstDateOf(new Date());
const BUD_DAYS_AGO = 6;

type DayTemp = { offset: number; tMean: number };
const DAYS: DayTemp[] = [
  { offset: 0, tMean: 35 }, // 出蕾日（数えない）
  { offset: 1, tMean: 20 },
  { offset: 2, tMean: 24.4 },
  { offset: 3, tMean: 15 },
  { offset: 4, tMean: 13 },
  { offset: 5, tMean: 25.6 },
  { offset: 6, tMean: 35 }, // 今日（数えない）
];
const HOURLY_DAY_OFFSET = 3;
const EXPECTED_BASE14 = 31;
const EXPECTED_BASE12 = 39;

async function recordBud(stemId: string, budDate: string) {
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

// 出蕾済みの茎（出蕾 BUD_DAYS_AGO 日前）と、気温（skip の日は入れない）
async function setupFloweredStem(prefix: string, options: { weather?: boolean; skipOffsets?: number[] } = {}) {
  const { weather = true, skipOffsets = [] } = options;
  const field = await createField(prefix);
  const matId = await createMat(field.id, `${field.code}-001`, addDays(today(), -120));
  const stemId = await createStem(matId, { startedAt: addDays(today(), -120), initialLeafCount: 5 });
  const budDate = addDays(today(), -BUD_DAYS_AGO);
  await recordBud(stemId, budDate);
  if (weather) {
    const supabase = await supabaseAsA();
    // organization_id は渡さない（INSERT トリガーが圃場からコピーする）
    const daily = DAYS.filter((d) => !skipOffsets.includes(d.offset)).map((d) => ({
      field_id: field.id,
      date: addDays(budDate, d.offset),
      t_mean: d.tMean,
      t_min: d.tMean - 5,
      t_max: d.tMean + 5,
      api: "archive",
    }));
    const { error } = await supabase.from("weather_daily").insert(daily);
    if (error) throw new Error(`weather_daily を入れられません: ${error.message}`);
    if (!skipOffsets.includes(HOURLY_DAY_OFFSET)) {
      const date = addDays(budDate, HOURLY_DAY_OFFSET);
      const hourly = Array.from({ length: 24 }, (_, h) => ({
        field_id: field.id,
        ts: `${date}T${String(h).padStart(2, "0")}:00:00+09:00`,
        temp_c: h < 12 ? 10 : 20,
        api: "archive",
      }));
      const { error: hError } = await supabase.from("weather_hourly").insert(hourly);
      if (hError) throw new Error(`weather_hourly を入れられません: ${hError.message}`);
    }
  }
  return { field, matId, stemId, budDate };
}

async function openStem(page: Page, stemId: string) {
  await page.goto(`/stems/${stemId}`);
  await expect(page.getByTestId("stem-record")).toBeVisible({ timeout: ACTION_TIMEOUT });
}

// 圃場の詳細の「予測の設定」で基準温度を保存する（空文字なら品種の既定に戻す）
async function saveBaseTemp(page: Page, fieldId: string, value: string) {
  await page.goto(`/fields/${fieldId}`);
  const form = page.getByTestId("prediction-params-form").filter({ hasText: "ドワーフナムワ" });
  await expect(form).toBeVisible({ timeout: ACTION_TIMEOUT });
  await form.getByTestId("prediction-base-temp").fill(value);
  await form.getByTestId("prediction-save").click();
  await expect(form).toHaveAttribute("data-attempts", "1", { timeout: ACTION_TIMEOUT });
  await expect(form.getByTestId("prediction-saved")).toHaveAttribute("data-saved", "1");
  await expect(form).toHaveAttribute("data-pending", "false");
  return form;
}

async function paramsRow(fieldId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("field_cultivar_params")
    .select("cultivar_id, base_temp_c, flowering_to_harvest_gdd, organization_id")
    .eq("field_id", fieldId);
  if (error) throw new Error(`field_cultivar_params を読めません: ${error.message}`);
  return data ?? [];
}

test("完了条件 2: 出蕾済みの茎の画面に、出蕾からの日数と積算温度（手計算と一致）が出る", async ({ page }) => {
  const { stemId, budDate } = await setupFloweredStem("E2E積算温度");
  await openStem(page, stemId);

  const section = page.getByTestId("stem-gdd");
  await expect(section).toHaveAttribute("data-state", "ok");
  await expect(page.getByTestId("stem-gdd-days")).toHaveText(String(BUD_DAYS_AGO));
  await expect(page.getByTestId("stem-gdd-total")).toHaveText(String(EXPECTED_BASE14));
  await expect(page.getByTestId("stem-gdd-summary")).toHaveText(`出蕾から ${BUD_DAYS_AGO} 日、積算温度 ${EXPECTED_BASE14} ℃・日`);
  // 丸める前の値も手計算と一致（時間別の日は時間別で計算している: 日平均で計算すると 29）
  expect(Number(await section.getAttribute("data-total"))).toBeCloseTo(EXPECTED_BASE14, 6);
  // 基準温度を小さく併記（品種の既定 14℃）。積算は昨日まで
  await expect(page.getByTestId("stem-gdd-base")).toHaveText(
    `基準 14℃（${budDate} 出蕾、${addDays(today(), -1)} までの気温）`,
  );
  // 欠けた日は無い
  await expect(page.getByTestId("stem-gdd-missing")).toHaveCount(0);
});

test("完了条件 3: 圃場の詳細で基準温度を変えると積算温度が変わり、空欄に戻すと品種の既定に戻る", async ({ page }) => {
  const { field, stemId } = await setupFloweredStem("E2E基準温度");
  const cultivarId = await dwarfNamwaId();

  await openStem(page, stemId);
  await expect(page.getByTestId("stem-gdd-total")).toHaveText(String(EXPECTED_BASE14));

  // 12℃ にする → 39
  const form = await saveBaseTemp(page, field.id, "12");
  await expect(form.getByTestId("prediction-base-temp")).toHaveValue("12");
  const rows = await paramsRow(field.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ cultivar_id: cultivarId, flowering_to_harvest_gdd: null });
  expect(Number(rows[0].base_temp_c)).toBe(12);
  // organization_id はアプリから渡していない（トリガーが圃場からコピー）
  expect(rows[0].organization_id).toBe(
    (await (await supabaseAsA()).from("fields").select("organization_id").eq("id", field.id).single()).data?.organization_id,
  );

  await openStem(page, stemId);
  await expect(page.getByTestId("stem-gdd-total")).toHaveText(String(EXPECTED_BASE12));
  await expect(page.getByTestId("stem-gdd-base")).toContainText("基準 12℃");
  expect(Number(await page.getByTestId("stem-gdd").getAttribute("data-total"))).toBeCloseTo(EXPECTED_BASE12, 6);

  // 再読み込みしても設定が残っている
  await page.goto(`/fields/${field.id}`);
  await expect(page.getByTestId("prediction-base-temp")).toHaveValue("12", { timeout: ACTION_TIMEOUT });

  // 空欄にする → 品種の既定（14℃）に戻る
  await saveBaseTemp(page, field.id, "");
  expect((await paramsRow(field.id))[0].base_temp_c).toBeNull();
  await openStem(page, stemId);
  await expect(page.getByTestId("stem-gdd-total")).toHaveText(String(EXPECTED_BASE14));
  await expect(page.getByTestId("stem-gdd-base")).toContainText("基準 14℃");
});

test("予測の設定: 基準温度は 5〜20℃、目標積算温度も範囲を検証し、範囲外は保存しない", async ({ page }) => {
  const field = await createField("E2E予測設定");
  await page.goto(`/fields/${field.id}`);
  const form = page.getByTestId("prediction-params-form").filter({ hasText: "ドワーフナムワ" });
  await expect(form).toBeVisible({ timeout: ACTION_TIMEOUT });
  // 既定値の案内
  await expect(form).toContainText("空欄なら品種の既定 14℃");
  await expect(form).toContainText("空欄なら品種の既定 900 ℃・日");

  let attempts = 0;
  // 送信して、応答（data-attempts が増え、送信中でなくなる）を待つ。待たずに次を入力すると、応答後のフォームのリセットで上書きされる
  const submit = async () => {
    await form.getByTestId("prediction-save").click();
    attempts++;
    await expect(form).toHaveAttribute("data-attempts", String(attempts), { timeout: ACTION_TIMEOUT });
    await expect(form).toHaveAttribute("data-pending", "false");
  };
  for (const v of ["4.9", "20.1"]) {
    await form.getByTestId("prediction-base-temp").fill(v);
    await submit();
    await expect(form.getByTestId("prediction-base-temp-error")).toHaveText("基準温度は 5〜20℃ の範囲で入力してください", {
      timeout: ACTION_TIMEOUT,
    });
  }
  await form.getByTestId("prediction-base-temp").fill("");
  await form.getByTestId("prediction-target-gdd").fill("50");
  await submit();
  await expect(form.getByTestId("prediction-target-gdd-error")).toHaveText(
    "目標積算温度は 100〜5,000 ℃・日の範囲で入力してください",
    { timeout: ACTION_TIMEOUT },
  );
  expect(await paramsRow(field.id)).toEqual([]);

  // 境界の 5℃ と 目標 1,100 は保存できる
  await form.getByTestId("prediction-base-temp").fill("5");
  await form.getByTestId("prediction-target-gdd").fill("1100");
  await submit();
  await expect(form.getByTestId("prediction-saved")).toHaveText("保存しました", { timeout: ACTION_TIMEOUT });
  const rows = await paramsRow(field.id);
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].base_temp_c)).toBe(5);
  expect(Number(rows[0].flowering_to_harvest_gdd)).toBe(1100);

  // DB の検査も範囲外を拒否する（0020）
  const supabase = await supabaseAsA();
  const { error } = await supabase
    .from("field_cultivar_params")
    .update({ base_temp_c: 25 })
    .eq("field_id", field.id);
  expect(error?.code).toBe("23514");
});

test("気温が欠けている日があると「気温が欠けている日が N 日あります」。その日は積算に入らない", async ({ page }) => {
  // d4（13℃、基準 14 で 0）ではなく d2（24.4℃、10.4）を欠かす → 31 − 10.4 = 20.6 → 21
  const { stemId } = await setupFloweredStem("E2E気温欠け", { skipOffsets: [2] });
  await openStem(page, stemId);
  await expect(page.getByTestId("stem-gdd-missing")).toHaveText("気温が欠けている日が 1 日あります（その日は積算に入っていません）");
  await expect(page.getByTestId("stem-gdd-total")).toHaveText("21");
  await expect(page.getByTestId("stem-gdd-days")).toHaveText(String(BUD_DAYS_AGO));
});

test("時間別だけが欠けた日は日平均で計算する（欠けた日には数えない）", async ({ page }) => {
  const { field, stemId, budDate } = await setupFloweredStem("E2E時間別欠け");
  // d3 の時間別を 1 時間だけ消す → 24 時間そろわないので日平均（15 − 14 = 1）で計算: 31 − 3 + 1 = 29
  const supabase = await supabaseAsA();
  const { error } = await supabase
    .from("weather_hourly")
    .delete()
    .eq("field_id", field.id)
    .eq("ts", `${addDays(budDate, HOURLY_DAY_OFFSET)}T05:00:00+09:00`);
  expect(error).toBeNull();
  await openStem(page, stemId);
  await expect(page.getByTestId("stem-gdd-total")).toHaveText("29");
  await expect(page.getByTestId("stem-gdd-missing")).toHaveCount(0);
});

test("気温がまだ取り込まれていない圃場では、その旨を出す", async ({ page }) => {
  const { stemId } = await setupFloweredStem("E2E気温なし", { weather: false });
  await openStem(page, stemId);
  await expect(page.getByTestId("stem-gdd")).toHaveAttribute("data-state", "not-imported");
  await expect(page.getByTestId("stem-gdd-not-imported")).toHaveText(
    "気温がまだ取り込まれていません（圃場の詳細で最終取得を確認）",
  );
  await expect(page.getByTestId("stem-gdd-total")).toHaveCount(0);
});

test("出蕾前の茎には積算温度を出さない", async ({ page }) => {
  const field = await createField("E2E出蕾前");
  const matId = await createMat(field.id, `${field.code}-001`);
  const stemId = await createStem(matId);
  await openStem(page, stemId);
  await expect(page.getByTestId("stem-cumulative-leaves")).toBeVisible();
  await expect(page.getByTestId("stem-gdd")).toHaveCount(0);
  await expect(page.getByText("積算温度")).toHaveCount(0);
});

test.describe("他組織", () => {
  test.use({ storageState: AUTH_STATE_B });

  test("テスト農園 B からは A の予測の設定と気温が見えず、書けない", async ({ page }) => {
    const { field } = await setupFloweredStem("E2E予測設定他組織");
    const cultivarId = await dwarfNamwaId();
    const a = await supabaseAsA();
    const { error: aError } = await a
      .from("field_cultivar_params")
      .upsert({ field_id: field.id, cultivar_id: cultivarId, base_temp_c: 12 }, { onConflict: "field_id,cultivar_id" });
    expect(aError).toBeNull();

    const b = await supabaseAsB();
    // 見えない
    const { data: seen } = await b.from("field_cultivar_params").select("field_id").eq("field_id", field.id);
    expect(seen).toEqual([]);
    const { data: hourly } = await b.from("weather_hourly_days").select("date").eq("field_id", field.id);
    expect(hourly).toEqual([]);
    const { data: daily } = await b.from("weather_daily").select("date").eq("field_id", field.id);
    expect(daily).toEqual([]);
    // 書けない（insert も update も）
    const { error: insertError } = await b
      .from("field_cultivar_params")
      .upsert({ field_id: field.id, cultivar_id: cultivarId, base_temp_c: 18 }, { onConflict: "field_id,cultivar_id" });
    expect(insertError).not.toBeNull();
    const { data: updated } = await b
      .from("field_cultivar_params")
      .update({ base_temp_c: 18 })
      .eq("field_id", field.id)
      .select("field_id");
    expect(updated ?? []).toEqual([]);
    const after = await paramsRow(field.id);
    expect(Number(after[0].base_temp_c)).toBe(12);

    // 画面: A の圃場の詳細は 404（予測の設定の区画も出ない）
    await page.goto(`/fields/${field.id}`);
    await expect(page.getByRole("heading", { name: "404" })).toBeVisible({ timeout: ACTION_TIMEOUT });
    await expect(page.getByTestId("prediction-settings")).toHaveCount(0);
  });
});

// 2-9 オフラインの殻: 茎の画面の部品を共有している。気温はキャッシュしないので、出蕾済みの茎は理由を出し、
// それ以外の表示（ヘッダ・累計葉数）は壊れない（cache.spec.ts と同じ手順でキャッシュを取り込んでから圏外にする）
test("オフラインの殻の茎の画面: 出蕾済みなら「オフラインでは積算温度を表示できません」、ほかの表示は壊れない", async ({
  page,
  context,
}) => {
  const { field, stemId } = await setupFloweredStem("E2E積算温度殻");
  await page.goto("/");
  await expect(page.getByTestId("organization-name")).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: ACTION_TIMEOUT });
  const status = page.getByTestId("sync-status");
  await expect
    .poll(
      async () =>
        Boolean(await status.getAttribute("data-cache-synced-at")) && (await status.getAttribute("data-cache-running")) !== "true",
      { timeout: 30_000 },
    )
    .toBe(true);

  await context.setOffline(true);
  try {
    await page.goto(`/stems/${stemId}`);
    await expect(page.getByTestId("offline-shell-banner")).toBeVisible({ timeout: ACTION_TIMEOUT });
    const main = page.locator("main:visible");
    await expect(main.getByTestId("stem-mat-code")).toHaveText(`${field.code}-001`);
    await expect(main.getByTestId("stem-status")).toHaveText("出蕾済み");
    await expect(main.getByTestId("stem-gdd")).toHaveAttribute("data-state", "offline");
    await expect(main.getByTestId("stem-gdd-offline")).toHaveText(
      "オフラインでは積算温度を表示できません（電波のある所で開き直すと出ます）",
    );
    await expect(main.getByTestId("stem-gdd-total")).toHaveCount(0);
  } finally {
    await context.setOffline(false);
  }
});
