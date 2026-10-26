import type { BrowserContext, Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTION_TIMEOUT, expect, noSession, randomFieldCode, supabaseAsA, supabaseAsB, test } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";
import { addDays, eachDate, jstDateOf, normalsRange } from "../src/lib/weather/dates";
import { MOCK_FORECAST_BIAS_C, mockDailyMean } from "../src/lib/weather/mock";

// 3-1 気温の取り込み。Open-Meteo はモック（src/lib/weather/mock.ts）。playwright.config.ts の webServer が
// 開発サーバーを WEATHER_MOCK=1 で起動する（開発サーバーでだけ効く。本番の挙動は変わらない）。
// モックの日平均 = mockDailyMean(日付)（予報 API は + MOCK_FORECAST_BIAS_C）。値がこの式と合うことでモックが効いていることも確かめる。
//
// 取り込みの入口:
// - 圃場の登録（Server Action の after()）: 登録日（または最も古い茎）以降と直近 7 日。平年値の材料は取らない
// - 圃場の詳細の「気温を今すぐ取り込む」: 日次（Cron）と同じ処理を 1 圃場だけ（ログイン中のユーザーの権限）
// - /api/cron/weather（Vercel Cron）: service_role。?fieldId= でテスト用の圃場だけを処理する（本番の圃場と同居しているため）。
//   SUPABASE_SERVICE_ROLE_KEY が .env.local に無ければ、Cron を叩くテストはスキップ（401 の検証は鍵がなくても走る）
// 失敗は Cookie e2e-weather-fault（archive / forecast / all）で起こす（モックのときだけサーバーが読む）。

const BASE_URL = "http://127.0.0.1:3000";
const FAULT_COOKIE = "e2e-weather-fault";
// 過去 10 年分のモックを保存する（約 3,700 行の upsert）ので、取り込みの完了は長めに待つ
const SYNC_TIMEOUT = 60_000;

const today = () => jstDateOf(new Date());

// 10 年分（約 3,700 行）を保存する取り込みは、iphone プロジェクトだけで走らせる。DB の行の検証は画面幅に依存せず、
// 2 プロジェクトで走らせると並行して走る他の spec の Server Action が遅くなり、時間切れの失敗が出た（全件実行で 1 件ずつ）
function heavyOnlyOnIphone() {
  test.skip(test.info().project.name !== "iphone", "10 年分の取り込みは iphone プロジェクトだけで検証する（負荷を半分にする）");
}
const yesterday = () => addDays(today(), -1);

type DailyRow = { date: string; api: string; t_mean: number; temperature_offset_c: number };

async function dailyRows(supabase: SupabaseClient, fieldId: string): Promise<DailyRow[]> {
  const rows: DailyRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("weather_daily")
      .select("date, api, t_mean, temperature_offset_c")
      .eq("field_id", fieldId)
      .order("date")
      .range(from, from + 999);
    if (error) throw new Error(`weather_daily を読めません: ${error.message}`);
    rows.push(...((data ?? []) as DailyRow[]));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function hourlyCount(supabase: SupabaseClient, fieldId: string): Promise<number> {
  const { count, error } = await supabase
    .from("weather_hourly")
    .select("ts", { count: "exact", head: true })
    .eq("field_id", fieldId);
  if (error) throw new Error(`weather_hourly を読めません: ${error.message}`);
  return count ?? 0;
}

function expectMockValue(row: DailyRow) {
  const expected = mockDailyMean(row.date) + (row.api === "forecast" ? MOCK_FORECAST_BIAS_C : 0);
  expect(
    Math.abs(Number(row.t_mean) - expected),
    `${row.date} の日平均 ${row.t_mean} がモックの値 ${expected.toFixed(1)} と違います（開発サーバーが WEATHER_MOCK=1 で起動していない可能性）`,
  ).toBeLessThanOrEqual(0.06);
}

// 期待する日付の並び（平年値の材料 + 最も古い茎 〜 昨日）
function expectedDates(fillStart: string): string[] {
  const { from, to } = normalsRange(today());
  return [...new Set([...eachDate(from, to), ...eachDate(fillStart, yesterday())])].sort();
}

// テスト用の圃場（DB に直接作る。登録時の取り込みは走らない）に、days 日前に始まった茎を 1 本
async function fieldWithStem(days: number) {
  const field = await createField("E2E気温");
  const matId = await createMat(field.id, `${field.code}-001`);
  const startedAt = addDays(today(), -days);
  await createStem(matId, { startedAt });
  return { ...field, startedAt };
}

async function openFieldDetail(page: Page, fieldId: string) {
  await page.goto(`/fields/${fieldId}`);
  await expect(page.getByTestId("field-detail-name")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("weather-status")).toBeVisible({ timeout: ACTION_TIMEOUT });
}

// 「気温を今すぐ取り込む」を押して、結果（成功の文言 or 失敗の文言）が出るまで待つ。n 回目
async function syncNow(page: Page, n: number) {
  const button = page.getByTestId("weather-sync-now");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.locator(`[data-testid^="weather-sync-"][data-done="${n}"]`)).toBeVisible({ timeout: SYNC_TIMEOUT });
}

async function setFault(context: BrowserContext, value: "archive" | "forecast" | "all" | null) {
  await context.clearCookies({ name: FAULT_COOKIE });
  if (value) await context.addCookies([{ name: FAULT_COOKIE, value, url: BASE_URL }]);
}

test.describe("3-1 気温の取り込み", () => {
  test.describe.configure({ timeout: 120_000 });

  test("完了条件 1: 圃場を登録すると、登録日（の前日）までの日別気温が weather_daily に入り、圃場の詳細に最終取得が出る", async ({ page }) => {
    const name = `E2E気温登録-${test.info().project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await page.goto("/fields/new");
    await expect(page.getByRole("form", { name: "圃場の新規登録" })).toBeVisible();
    await page.getByLabel("名前").fill(name);
    await page.getByLabel("圃場記号").fill(randomFieldCode());
    await page.getByLabel("緯度").fill("26.5");
    await page.getByLabel("経度").fill("127.9");
    await page.getByRole("button", { name: "登録" }).click();
    await expect(page).toHaveURL("/fields", { timeout: ACTION_TIMEOUT });

    const supabase = await supabaseAsA();
    const { data: field } = await supabase.from("fields").select("id").eq("name", name).single();
    const fieldId = field!.id as string;

    // 登録の応答の後（after()）に取り込むので、行が入るまで待つ
    const expected = eachDate(addDays(today(), -7), yesterday());
    await expect
      .poll(async () => (await dailyRows(supabase, fieldId)).map((r) => r.date), { timeout: SYNC_TIMEOUT })
      .toEqual(expected);
    // 取り込みの完了を待つ（after() の取り込みは 日次 → 時間別 → 取り込みの記録（record_weather_sync）の順。記録が最後）
    await expect
      .poll(
        async () => {
          const { data } = await supabase.from("weather_sync_status").select("last_run_at").eq("field_id", fieldId);
          return (data ?? []).length;
        },
        { timeout: SYNC_TIMEOUT },
      )
      .toBe(1);
    const rows = await dailyRows(supabase, fieldId);
    // 登録日の前日（昨日）まで 1 日 1 行。今日（途中の日）は入れない
    expect(rows.at(-1)?.date).toBe(yesterday());
    expect(rows.some((r) => r.date === today())).toBe(false);
    for (const r of rows) {
      expectMockValue(r);
      expect(Number(r.temperature_offset_c)).toBe(0);
    }
    // 時間別も同じ日数 × 24
    expect(await hourlyCount(supabase, fieldId)).toBe(expected.length * 24);

    // 圃場の詳細（iPhone 幅でも）に「気温: 最終取得 ◯月◯日 ◯:◯◯（7日分）」
    await openFieldDetail(page, fieldId);
    await expect(page.getByTestId("weather-status")).toHaveText(/^気温: 最終取得 \d{1,2}月\d{1,2}日 \d{1,2}:\d{2}（7日分）$/);
    await expect(page.getByTestId("weather-status")).toHaveAttribute("data-state", "ok");
    await expect(page.getByTestId("weather-stored")).toContainText(`保存済み 7日分（${expected[0]}〜）`);
    await expect(page.getByTestId("weather-error")).toHaveCount(0);
  });

  test("完了条件 2: 日次の取り込み（今すぐ取り込む）を 2 回走らせても行が重複しない。平年値の材料（10 年分）と茎の開始日からの分が入る", async ({
    page,
  }) => {
    heavyOnlyOnIphone();
    const field = await fieldWithStem(20);
    const supabase = await supabaseAsA();

    // 取り込み前は「取り込み待ち」
    await openFieldDetail(page, field.id);
    await expect(page.getByTestId("weather-status")).toHaveText("気温: 取り込み待ち");
    await expect(page.getByTestId("weather-status")).toHaveAttribute("data-state", "pending");

    await syncNow(page, 1);
    await expect(page.getByTestId("weather-sync-message")).toBeVisible();
    const first = await dailyRows(supabase, field.id);
    const hourly1 = await hourlyCount(supabase, field.id);
    const expected = expectedDates(field.startedAt);
    expect(first.map((r) => r.date)).toEqual(expected);
    // 「◯日分」は保存した日別の行数（予報と過去の両方で書いた日も 1 日と数える）
    await expect(page.getByTestId("weather-status")).toContainText(`（${expected.length.toLocaleString("ja-JP")}日分）`);
    // 確定値が出ている日（5 日前まで）は過去 API、直近は予報 API
    for (const r of first) {
      expect(r.api).toBe(r.date <= addDays(today(), -5) ? "archive" : "forecast");
      expectMockValue(r);
    }
    // 時間別は茎の開始日 〜 昨日だけ（10 年分は日次だけ）
    expect(hourly1).toBe(eachDate(field.startedAt, yesterday()).length * 24);

    await syncNow(page, 2);
    await expect(page.getByTestId("weather-sync-message")).toBeVisible();
    const second = await dailyRows(supabase, field.id);
    expect(second.length).toBe(first.length);
    expect(new Set(second.map((r) => r.date)).size).toBe(second.length);
    expect(await hourlyCount(supabase, field.id)).toBe(hourly1);

    // 圃場の詳細の表示（再描画後）
    await expect(page.getByTestId("weather-status")).toHaveText(/^気温: 最終取得 \d{1,2}月\d{1,2}日 \d{1,2}:\d{2}（\d+日分）$/);
    await expect(page.getByTestId("weather-stored")).toContainText(
      `保存済み ${expected.length.toLocaleString("ja-JP")}日分（${expected[0]}〜）`,
    );
  });

  test("完了条件 3: 過去 API が失敗しても、次回の取り込みで欠けた日が埋まる。失敗の理由が圃場の詳細に出る", async ({
    page,
    context,
  }) => {
    heavyOnlyOnIphone();
    const field = await fieldWithStem(30);
    const supabase = await supabaseAsA();
    const fill = eachDate(field.startedAt, yesterday());

    await openFieldDetail(page, field.id);
    // 1 回目: 過去 API だけ失敗（予報 API の直近 7 日だけ入る）
    await setFault(context, "archive");
    await syncNow(page, 1);
    await expect(page.getByTestId("weather-sync-error")).toContainText("一部を取り込めませんでした");
    const afterFail = await dailyRows(supabase, field.id);
    const recent = eachDate(addDays(today(), -7), yesterday());
    expect(afterFail.map((r) => r.date)).toEqual(recent);
    expect(afterFail.every((r) => r.api === "forecast")).toBe(true);
    const missing = fill.filter((d) => !afterFail.some((r) => r.date === d));
    expect(missing.length).toBe(fill.length - recent.length);
    // 圃場の詳細に失敗の理由
    await expect(page.getByTestId("weather-status")).toHaveAttribute("data-state", "error");
    // 画面には要約（API・理由・欠けた日数）だけ。期間ごとのエラーを並べない
    const errorText = (await page.getByTestId("weather-error").textContent()) ?? "";
    expect(errorText).toContain("Open-Meteo の過去 API から取得できませんでした（HTTP 503）");
    expect(errorText).toContain(`欠けた日 `);
    expect(errorText).not.toMatch(/\d{4}-\d{2}-\d{2}〜/);
    expect(errorText.length).toBeLessThan(160);
    // 一部は保存できたので、最終取得はこの回（予報 API の 7 日分）
    await expect(page.getByTestId("weather-status")).toHaveText(/^気温: 最終取得 \d{1,2}月\d{1,2}日 \d{1,2}:\d{2}（7日分）$/);

    // 2 回目: 障害が直った → 欠けた日がまとめて埋まり、5 日より前の暫定値は確定値で上書きされる
    await setFault(context, null);
    await syncNow(page, 2);
    await expect(page.getByTestId("weather-sync-message")).toBeVisible();
    const afterRetry = await dailyRows(supabase, field.id);
    const dates = afterRetry.map((r) => r.date);
    for (const d of fill) expect(dates, `${d} が埋まっていない`).toContain(d);
    expect(dates).toEqual(expectedDates(field.startedAt));
    expect(new Set(dates).size).toBe(dates.length);
    for (const r of afterRetry) {
      if (r.date <= addDays(today(), -5)) expect(r.api, `${r.date} は確定値で上書きされるはず`).toBe("archive");
      expectMockValue(r);
    }
    await expect(page.getByTestId("weather-status")).toHaveAttribute("data-state", "ok");
    await expect(page.getByTestId("weather-error")).toHaveCount(0);
    const okText = await page.getByTestId("weather-status").textContent();

    // 3 回目: 全部失敗（0 日）しても「最終取得」は前に成功した回のまま。失敗は要約で出る
    await setFault(context, "all");
    await syncNow(page, 3);
    await expect(page.getByTestId("weather-status")).toHaveAttribute("data-state", "error");
    await expect(page.getByTestId("weather-status")).toHaveText(okText!);
    await expect(page.getByTestId("weather-error")).toContainText("Open-Meteo の予報 API から取得できませんでした（HTTP 503）");
    await setFault(context, null);
  });

  test("テスト農園 B からは A の圃場の気温と取り込みの記録が見えない（RLS）", async ({ page }) => {
    heavyOnlyOnIphone();
    const field = await fieldWithStem(3);
    await openFieldDetail(page, field.id);
    await syncNow(page, 1);
    const a = await supabaseAsA();
    expect((await dailyRows(a, field.id)).length).toBeGreaterThan(0);
    const { data: statusA } = await a.from("weather_sync_status").select("field_id").eq("field_id", field.id);
    expect(statusA).toHaveLength(1);

    const b = await supabaseAsB();
    expect(await dailyRows(b, field.id)).toEqual([]);
    expect(await hourlyCount(b, field.id)).toBe(0);
    const { data: statusB } = await b.from("weather_sync_status").select("field_id").eq("field_id", field.id);
    expect(statusB).toEqual([]);
    // B は取り込みの記録を書けない（record_weather_sync は自組織の圃場だけ）
    const { error } = await b.rpc("record_weather_sync", {
      p_field_id: field.id,
      p_ran_at: new Date().toISOString(),
      p_days: 0,
      p_error: "B から",
      p_lat: 0,
      p_lng: 0,
    });
    expect(error).not.toBeNull();
    // B は A の圃場の気温を書き込めない（RLS）
    const { error: insertError } = await b
      .from("weather_daily")
      .insert({ field_id: field.id, date: "2000-01-01", t_mean: 20, t_min: 15, t_max: 25 });
    expect(insertError).not.toBeNull();
  });
});

test.describe("3-1 Cron の Route Handler（/api/cron/weather）", () => {
  test.use({ storageState: noSession });

  test("シークレットなし・違うシークレットでは 401（未ログインでも /login に転送しない）", async ({ request }) => {
    const none = await request.get("/api/cron/weather", { maxRedirects: 0 });
    expect(none.status()).toBe(401);
    const wrong = await request.get("/api/cron/weather", {
      headers: { authorization: "Bearer wrong-secret" },
      maxRedirects: 0,
    });
    expect(wrong.status()).toBe(401);
    const noBearer = await request.get("/api/cron/weather", {
      headers: { authorization: process.env.CRON_SECRET ?? "" },
      maxRedirects: 0,
    });
    expect(noBearer.status()).toBe(401);
  });

  test("Cron を 2 回叩いても行が重複せず、過去 API の失敗で欠けた日は次の Cron で埋まる（?fieldId= でテスト用の圃場だけ）", async ({
    request,
  }) => {
    test.skip(
      !process.env.SUPABASE_SERVICE_ROLE_KEY,
      "SUPABASE_SERVICE_ROLE_KEY が .env.local にない（Cron の Route Handler は service_role で動く）",
    );
    heavyOnlyOnIphone();
    test.setTimeout(120_000);
    const field = await fieldWithStem(15);
    const supabase = await supabaseAsA();
    const auth = { authorization: `Bearer ${process.env.CRON_SECRET}` };
    const url = `/api/cron/weather?fieldId=${field.id}`;

    // 1 回目: 過去 API の障害
    const r1 = await request.get(url, { headers: { ...auth, [FAULT_COOKIE]: "archive" }, timeout: SYNC_TIMEOUT });
    expect(r1.status()).toBe(200);
    const b1 = await r1.json();
    expect(b1.processed).toBe(1);
    expect(b1.results[0].fieldId).toBe(field.id);
    expect(b1.results[0].errors.length).toBeGreaterThan(0);
    expect((await dailyRows(supabase, field.id)).map((r) => r.date)).toEqual(eachDate(addDays(today(), -7), yesterday()));

    // 2 回目: 欠けた日が埋まる
    const r2 = await request.get(url, { headers: auth, timeout: SYNC_TIMEOUT });
    expect(r2.status()).toBe(200);
    expect((await r2.json()).results[0].errors).toEqual([]);
    const second = await dailyRows(supabase, field.id);
    expect(second.map((r) => r.date)).toEqual(expectedDates(field.startedAt));
    const hourly2 = await hourlyCount(supabase, field.id);

    // 3 回目: 行が重複しない
    const r3 = await request.get(url, { headers: auth, timeout: SYNC_TIMEOUT });
    expect(r3.status()).toBe(200);
    const third = await dailyRows(supabase, field.id);
    expect(third.length).toBe(second.length);
    expect(new Set(third.map((r) => r.date)).size).toBe(third.length);
    expect(await hourlyCount(supabase, field.id)).toBe(hourly2);
  });
});
