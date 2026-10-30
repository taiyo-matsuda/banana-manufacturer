import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, AUTH_STATE_B, expect, supabaseAsA, test } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";
import { addDays, jstDateOf } from "../src/lib/weather/dates";

// 3-6 予測一覧（画面 7、prediction.md 8 章）。完了条件 1・2 を 1 つずつ検証する（週への集計そのものは src/lib/forecast.test.ts）。
// テスト農園 A でログイン済み（setup の storageState）。テストごとにログインしない。
// 圃場・株・茎は DB に直接作り、出蕾は RPC、収穫予測（estimates）は A のクライアントで直接追記する
// （予測の計算は 3-3 の prediction.spec で検証済み。ここでは予測日を決めて、週への数え方だけを見る）。
// 予測一覧には他のテストの茎も並ぶので、本数はテストごとの圃場で絞り込んで（/forecast?field=<id>）数える。

const view = (page: Page) => page.locator("main:visible");
const today = () => jstDateOf(new Date());

// 日本時間の今日を含む週の月曜（実装の関数を使わずに求める）
function thisMonday(): string {
  const t = today();
  const dow = new Date(`${t}T00:00:00Z`).getUTCDay(); // 0 = 日曜
  return addDays(t, -((dow + 6) % 7));
}
function md(date: string) {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

async function setupFlowered(fieldId: string, code: string, budDate: string) {
  const matId = await createMat(fieldId, code, addDays(today(), -200));
  const stemId = await createStem(matId, { startedAt: addDays(today(), -200), initialLeafCount: 5 });
  const supabase = await supabaseAsA();
  const { error } = await supabase.rpc("record_stem_event", {
    p_id: crypto.randomUUID(),
    p_stem_id: stemId,
    p_type: "bud_emerged",
    p_occurred_at: `${budDate}T00:00:00+09:00`,
    p_payload: { cumulative_leaves: 30, leaves_current: 12, girth_cm: 50, earliest_at: null },
  });
  if (error) throw new Error(`出蕾を記録できません: ${error.message}`);
  return { matId, stemId };
}

// 収穫予測を追記する（organization_id はトリガーが茎からコピーする）
async function insertEstimate(
  stemId: string,
  e: { value: string; lower: string; upper: string; severe?: boolean } | { unavailable: "no_normals" | "never_reaches" },
) {
  const supabase = await supabaseAsA();
  const row =
    "unavailable" in e
      ? { value_date: null, lower_date: null, upper_date: null, inputs: { unavailable_reason: e.unavailable } }
      : { value_date: e.value, lower_date: e.lower, upper_date: e.upper, inputs: { damage: e.severe ? "severe" : null } };
  const { error } = await supabase
    .from("estimates")
    .insert({ stem_id: stemId, kind: "harvest_date", model_version: "harvest-gdd-v1", ...row });
  if (error) throw new Error(`推定を入れられません: ${error.message}`);
}

async function recordLost(stemId: string) {
  const supabase = await supabaseAsA();
  const { error } = await supabase.rpc("record_stem_event", {
    p_id: crypto.randomUUID(),
    p_stem_id: stemId,
    p_type: "damage",
    p_occurred_at: new Date().toISOString(),
    p_payload: { kind: "lodging", severity: "lost" },
  });
  if (error) throw new Error(`喪失を記録できません: ${error.message}`);
}

async function openForecast(page: Page, fieldId?: string) {
  await page.goto(fieldId ? `/forecast?field=${fieldId}` : "/forecast");
  await expect(view(page).getByTestId("forecast-view")).toBeVisible({ timeout: ACTION_TIMEOUT });
}

const weekRow = (page: Page, weekStart: string) => view(page).locator(`[data-testid="forecast-week"][data-week-start="${weekStart}"]`);
const stemRow = (page: Page, stemId: string) => view(page).locator(`[data-testid="forecast-stem"][data-stem-id="${stemId}"]`);

async function expectWeek(page: Page, weekStart: string, count: number, needsReview: number) {
  const row = weekRow(page, weekStart);
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("forecast-week-count")).toHaveText(`${count} 本`);
  await expect(row.getByTestId("forecast-week-needs-review")).toHaveText(`${needsReview} 本`);
}

test("完了条件 1: 出蕾済みの茎が予測日の週（月曜始まり）に数えられる。lost は数えず、要確認は別枠", async ({ page }) => {
  const field = await createField("E2E予測一覧");
  const nextMon = addDays(thisMonday(), 7);
  const nextSun = addDays(nextMon, 6);
  const later = addDays(thisMonday(), 21 + 2); // 3 週先の水曜
  const bud = addDays(today(), -60);

  // 来週の月曜と日曜（同じ週の両端）、来週の水曜（要確認）、3 週先、lost にした茎（来週の火曜の予測が残っている）
  const mon = await setupFlowered(field.id, `${field.code}-001`, bud);
  await insertEstimate(mon.stemId, { value: nextMon, lower: addDays(nextMon, -5), upper: addDays(nextMon, 5) });
  const sun = await setupFlowered(field.id, `${field.code}-002`, bud);
  await insertEstimate(sun.stemId, { value: nextSun, lower: addDays(nextSun, -5), upper: addDays(nextSun, 5) });
  const severe = await setupFlowered(field.id, `${field.code}-003`, bud);
  await insertEstimate(severe.stemId, { value: addDays(nextMon, 2), lower: addDays(nextMon, -3), upper: addDays(nextMon, 7), severe: true });
  const far = await setupFlowered(field.id, `${field.code}-004`, bud);
  await insertEstimate(far.stemId, { value: later, lower: addDays(later, -10), upper: addDays(later, 10) });
  const lost = await setupFlowered(field.id, `${field.code}-005`, bud);
  await insertEstimate(lost.stemId, { value: addDays(nextMon, 1), lower: nextMon, upper: addDays(nextMon, 3) });
  await recordLost(lost.stemId);
  // 予測できなかった茎（理由付き）と、まだ推定の無い茎は週に数えず、別の一覧に理由と出す
  const noNormals = await setupFlowered(field.id, `${field.code}-006`, bud);
  await insertEstimate(noNormals.stemId, { unavailable: "no_normals" });
  const pending = await setupFlowered(field.id, `${field.code}-007`, bud);
  // 出蕾前の茎は出さない
  const activeMat = await createMat(field.id, `${field.code}-008`, addDays(today(), -100));
  const active = await createStem(activeMat, { startedAt: addDays(today(), -100) });

  await openForecast(page, field.id);

  // 週ごとの表: 来週 = 2 本（月曜と日曜）＋ 要確認 1 本（別枠）。3 週先 = 1 本。lost は数えない
  await expectWeek(page, nextMon, 2, 1);
  await expect(weekRow(page, nextMon).getByTestId("forecast-week-label")).toHaveText(
    `${md(nextMon)}〜${nextMon.slice(0, 7) === nextSun.slice(0, 7) ? `${Number(nextSun.slice(8, 10))}日` : md(nextSun)}`,
  );
  await expect(weekRow(page, nextMon)).toContainText("来週");
  await expectWeek(page, addDays(thisMonday(), 21), 1, 0);
  await expect(view(page).getByTestId("forecast-week")).toHaveCount(2);
  await expect(view(page).getByTestId("forecast-week-overdue")).toHaveCount(0);
  await expect(view(page).getByTestId("forecast-total-count")).toHaveText("3 本");
  await expect(view(page).getByTestId("forecast-total-needs-review")).toHaveText("1 本");

  // 茎ごとの一覧: 株コード・圃場・出蕾日・予測日と幅・要確認。予測日の順
  const rows = view(page).getByTestId("forecast-stem");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toHaveAttribute("data-stem-id", mon.stemId);
  await expect(rows.nth(1)).toHaveAttribute("data-stem-id", severe.stemId);
  await expect(rows.nth(2)).toHaveAttribute("data-stem-id", sun.stemId);
  await expect(rows.nth(3)).toHaveAttribute("data-stem-id", far.stemId);
  const monRow = stemRow(page, mon.stemId);
  await expect(monRow).toHaveAttribute("data-week-start", nextMon);
  await expect(stemRow(page, sun.stemId)).toHaveAttribute("data-week-start", nextMon);
  await expect(monRow.getByTestId("forecast-stem-code")).toHaveText(`${field.code}-001`);
  await expect(monRow.getByTestId("forecast-stem-bud")).toContainText(md(bud));
  await expect(monRow.getByTestId("forecast-stem-harvest")).toContainText(`${md(nextMon)}ごろ`);
  await expect(monRow.getByTestId("forecast-stem-harvest")).toContainText(md(addDays(nextMon, -5)));
  await expect(monRow.getByTestId("forecast-stem-needs-review")).toHaveCount(0);
  await expect(stemRow(page, severe.stemId)).toHaveAttribute("data-needs-review", "true");
  await expect(stemRow(page, severe.stemId).getByTestId("forecast-stem-needs-review")).toHaveText("要確認");
  // lost・出蕾前の茎はどこにも出ない
  await expect(view(page).locator(`[data-stem-id="${lost.stemId}"]`)).toHaveCount(0);
  await expect(view(page).locator(`[data-stem-id="${active}"]`)).toHaveCount(0);

  // 予測できない茎
  const unavailable = view(page).getByTestId("forecast-unavailable-stem");
  await expect(unavailable).toHaveCount(2);
  await expect(view(page).locator(`[data-testid="forecast-unavailable-stem"][data-stem-id="${noNormals.stemId}"]`)).toHaveAttribute(
    "data-reason",
    "no_normals",
  );
  await expect(view(page).locator(`[data-testid="forecast-unavailable-stem"][data-stem-id="${pending.stemId}"]`)).toContainText(
    "まだ計算されていません",
  );

  // 株コードから茎の画面へ
  await monRow.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/stems/${mon.stemId}$`));
});

test("完了条件 1: 予測が更新されると新しい予測日の週に移り、予測日を過ぎた茎は別の行にまとめる", async ({ page }) => {
  const field = await createField("E2E予測一覧更新");
  const bud = addDays(today(), -60);
  const a = await setupFlowered(field.id, `${field.code}-001`, bud);
  const w1 = addDays(thisMonday(), 14);
  await insertEstimate(a.stemId, { value: w1, lower: addDays(w1, -3), upper: addDays(w1, 3) });
  const b = await setupFlowered(field.id, `${field.code}-002`, bud);
  const past = addDays(thisMonday(), -3); // 先週の金曜
  await insertEstimate(b.stemId, { value: past, lower: addDays(past, -3), upper: addDays(past, 3) });

  await openForecast(page, field.id);
  await expectWeek(page, w1, 1, 0);
  await expect(view(page).getByTestId("forecast-week-overdue").getByTestId("forecast-week-count")).toHaveText("1 本");
  await expect(stemRow(page, b.stemId)).toHaveAttribute("data-overdue", "true");

  // 最新の推定（latest_estimates）で数える: 予測が 1 週後ろにずれ、要確認になった
  const w2 = addDays(w1, 7 + 3);
  await insertEstimate(a.stemId, { value: w2, lower: addDays(w2, -3), upper: addDays(w2, 3), severe: true });
  await openForecast(page, field.id);
  await expect(weekRow(page, w1)).toHaveCount(0);
  await expectWeek(page, addDays(w1, 7), 0, 1);
  await expect(view(page).getByTestId("forecast-total-count")).toHaveText("1 本");
  await expect(view(page).getByTestId("forecast-total-needs-review")).toHaveText("1 本");
});

test("完了条件 2: 圃場で絞り込める（選ぶと ?field= に変わり、その圃場の茎だけを数える）", async ({ page }) => {
  const f1 = await createField("E2E予測一覧絞込1");
  const f2 = await createField("E2E予測一覧絞込2");
  const bud = addDays(today(), -60);
  const week = addDays(thisMonday(), 28);
  const s1 = await setupFlowered(f1.id, `${f1.code}-001`, bud);
  await insertEstimate(s1.stemId, { value: week, lower: addDays(week, -3), upper: addDays(week, 3) });
  const s2 = await setupFlowered(f2.id, `${f2.code}-001`, bud);
  await insertEstimate(s2.stemId, { value: addDays(week, 1), lower: addDays(week, -2), upper: addDays(week, 4) });
  const s2b = await setupFlowered(f2.id, `${f2.code}-002`, bud);
  await insertEstimate(s2b.stemId, { value: addDays(week, 2), lower: addDays(week, -1), upper: addDays(week, 5), severe: true });

  // すべての圃場: 両方の圃場の茎が出る
  await openForecast(page);
  const select = view(page).getByTestId("forecast-field-select");
  await expect(select).toHaveValue("");
  await expect(stemRow(page, s1.stemId)).toHaveCount(1);
  await expect(stemRow(page, s2.stemId)).toHaveCount(1);

  // 圃場 1 を選ぶ
  await select.selectOption(f1.id);
  await expect(page).toHaveURL(new RegExp(`/forecast\\?field=${f1.id}$`));
  await expect(view(page).getByTestId("forecast-field-select")).toHaveValue(f1.id);
  await expect(view(page).getByTestId("forecast-stem")).toHaveCount(1);
  await expect(stemRow(page, s1.stemId)).toHaveCount(1);
  await expectWeek(page, week, 1, 0);
  await expect(view(page).getByTestId("forecast-total-count")).toHaveText("1 本");

  // 圃場 2 を選ぶ
  await view(page).getByTestId("forecast-field-select").selectOption(f2.id);
  await expect(page).toHaveURL(new RegExp(`/forecast\\?field=${f2.id}$`));
  await expect(view(page).getByTestId("forecast-stem")).toHaveCount(2);
  await expect(stemRow(page, s1.stemId)).toHaveCount(0);
  await expectWeek(page, week, 1, 1);
  await expect(stemRow(page, s2.stemId).getByTestId("forecast-stem-field")).not.toHaveText("");

  // すべての圃場に戻す
  await view(page).getByTestId("forecast-field-select").selectOption("");
  await expect(page).toHaveURL(/\/forecast$/);
  await expect(stemRow(page, s1.stemId)).toHaveCount(1);
  await expect(stemRow(page, s2.stemId)).toHaveCount(1);
});

test("予測タブから開け、スマホ幅でも PC 幅でも横にはみ出さない", async ({ page }) => {
  const field = await createField("E2E予測一覧表示");
  const s = await setupFlowered(field.id, `${field.code}-001`, addDays(today(), -60));
  const v = addDays(thisMonday(), 10);
  await insertEstimate(s.stemId, { value: v, lower: addDays(v, -20), upper: addDays(v, 25), severe: true });

  await page.goto("/");
  await page.locator('[data-testid="bottom-nav"]:visible').getByTestId("nav-forecast").click();
  await expect(page).toHaveURL(/\/forecast$/);
  await expect(page.locator('[data-testid="bottom-nav"]:visible').getByTestId("nav-forecast")).toHaveAttribute("aria-current", "page");

  await openForecast(page, field.id);
  await expect(stemRow(page, s.stemId)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // 株コード・圃場・出蕾日・収穫予測・要確認が読める（スマホ幅では縦に積む）
  const row = stemRow(page, s.stemId);
  for (const id of ["forecast-stem-code", "forecast-stem-field", "forecast-stem-bud", "forecast-stem-harvest", "forecast-stem-needs-review"]) {
    await expect(row.getByTestId(id)).toBeVisible();
  }
});

test.describe("他組織", () => {
  test.use({ storageState: AUTH_STATE_B });

  test("テスト農園 B からは A の茎・圃場が見えない（?field= に A の圃場を指定しても）", async ({ page }) => {
    const field = await createField("E2E予測一覧他組織");
    const s = await setupFlowered(field.id, `${field.code}-001`, addDays(today(), -60));
    const v = addDays(thisMonday(), 7);
    await insertEstimate(s.stemId, { value: v, lower: v, upper: v });

    await openForecast(page);
    await expect(view(page).locator(`[data-stem-id="${s.stemId}"]`)).toHaveCount(0);
    await expect(view(page).getByTestId("forecast-field-select").locator(`option[value="${field.id}"]`)).toHaveCount(0);

    await openForecast(page, field.id);
    await expect(view(page).getByTestId("forecast-stem")).toHaveCount(0);
    await expect(view(page).getByTestId("forecast-total")).toHaveCount(0);
    await expect(view(page).getByTestId("forecast-empty")).toBeVisible();
  });
});
