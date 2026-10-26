// E2E 用の Open-Meteo のモック（fetch と同じ形）。本番では使わない（server.ts の weatherFetcher が開発サーバーでだけ選ぶ）。
// URL の start_date / end_date（過去 API）、past_days（予報 API）から、決まった式の時間別データを返す。
//
// 気温 = 22 + 6·sin(2π(通日 − 110)/365) + 3·sin(2π(時 − 9)/24)（時間の項は 1 日で平均 0 なので、日平均 = 22 + 6·sin(...)）
// 予報 API の値は過去 API より 0.5 ℃ 高くする（過去 API の確定値で上書きされたことを E2E で見分けるため）
// fault: 'archive' / 'forecast' / 'all' でその API を HTTP 503 で失敗させる（完了条件 3 の検証）
import { addDays, eachDate } from "./dates";
import { ARCHIVE_URL, FORECAST_URL, type FetchFn } from "./open-meteo";

export type MockFault = "archive" | "forecast" | "all" | null;

export const MOCK_FORECAST_BIAS_C = 0.5;

export function parseMockFault(v: string | null | undefined): MockFault {
  return v === "archive" || v === "forecast" || v === "all" ? v : null;
}

function dayOfYear(date: string): number {
  const d = Date.parse(`${date}T00:00:00Z`);
  const jan1 = Date.parse(`${date.slice(0, 4)}-01-01T00:00:00Z`);
  return Math.round((d - jan1) / 86_400_000) + 1;
}

// モックの日平均気温（補正なし・過去 API の値）
export function mockDailyMean(date: string): number {
  return 22 + 6 * Math.sin((2 * Math.PI * (dayOfYear(date) - 110)) / 365);
}

function hourlyFor(dates: readonly string[], bias: number) {
  const time: string[] = [];
  const temperature_2m: number[] = [];
  const precipitation: number[] = [];
  const wind_speed_10m: number[] = [];
  for (const date of dates) {
    const mean = mockDailyMean(date) + bias;
    const even = Number(date.slice(8, 10)) % 2 === 0;
    for (let h = 0; h < 24; h++) {
      time.push(`${date}T${String(h).padStart(2, "0")}:00`);
      temperature_2m.push(Math.round((mean + 3 * Math.sin((2 * Math.PI * (h - 9)) / 24)) * 100) / 100);
      precipitation.push(even && h === 3 ? 1.5 : 0);
      wind_speed_10m.push(2 + (h % 5) * 0.5);
    }
  }
  return { time, temperature_2m, precipitation, wind_speed_10m };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// today: 予報 API の past_days の基準（日本時間の今日）
export function createMockFetch(options: { today: string; fault?: MockFault }): FetchFn {
  const { today, fault = null } = options;
  return async (input) => {
    const url = new URL(input);
    const base = `${url.origin}${url.pathname}`;
    if (base === ARCHIVE_URL) {
      if (fault === "archive" || fault === "all") return json({ error: true, reason: "モック: 過去 API の障害" }, 503);
      const from = url.searchParams.get("start_date");
      const to = url.searchParams.get("end_date");
      if (!from || !to) return json({ error: true, reason: "start_date / end_date がない" }, 400);
      return json({ hourly: hourlyFor(eachDate(from, to), 0) });
    }
    if (base === FORECAST_URL) {
      if (fault === "forecast" || fault === "all") return json({ error: true, reason: "モック: 予報 API の障害" }, 503);
      const pastDays = Number(url.searchParams.get("past_days") ?? "0");
      return json({ hourly: hourlyFor(eachDate(addDays(today, -pastDays), today), MOCK_FORECAST_BIAS_C) });
    }
    return json({ error: true, reason: `モックにない URL: ${base}` }, 404);
  };
}
