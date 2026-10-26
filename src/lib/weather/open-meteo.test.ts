import { describe, expect, it } from "vitest";
import { createMockFetch, mockDailyMean, MOCK_FORECAST_BIAS_C } from "./mock";
import { hourlyToDaily } from "./aggregate";
import {
  archiveUrl,
  fetchHourly,
  forecastUrl,
  parseHourly,
  WeatherFetchError,
  type FetchFn,
} from "./open-meteo";

describe("URL", () => {
  it("予報 API: 時間別の気温・降水・風速、m/s、Asia/Tokyo、past_days", () => {
    const u = new URL(forecastUrl(26.21234567, 127.6789));
    expect(`${u.origin}${u.pathname}`).toBe("https://api.open-meteo.com/v1/forecast");
    expect(u.searchParams.get("latitude")).toBe("26.2123");
    expect(u.searchParams.get("longitude")).toBe("127.6789");
    expect(u.searchParams.get("hourly")).toBe("temperature_2m,precipitation,wind_speed_10m");
    expect(u.searchParams.get("wind_speed_unit")).toBe("ms");
    expect(u.searchParams.get("timezone")).toBe("Asia/Tokyo");
    expect(u.searchParams.get("past_days")).toBe("7");
  });
  it("過去 API: start_date / end_date", () => {
    const u = new URL(archiveUrl(26.2, 127.7, "2016-01-01", "2016-12-31"));
    expect(`${u.origin}${u.pathname}`).toBe("https://archive-api.open-meteo.com/v1/archive");
    expect(u.searchParams.get("start_date")).toBe("2016-01-01");
    expect(u.searchParams.get("end_date")).toBe("2016-12-31");
    expect(u.searchParams.get("timezone")).toBe("Asia/Tokyo");
  });
});

describe("parseHourly", () => {
  it("time と各値を点の並びにする（数値でない値は null）", () => {
    const points = parseHourly({
      hourly: {
        time: ["2026-01-01T00:00", "2026-01-01T01:00"],
        temperature_2m: [15.2, null],
        precipitation: [0, 0.4],
        wind_speed_10m: [3.1, 2],
      },
    });
    expect(points).toEqual([
      { time: "2026-01-01T00:00", temp: 15.2, precip: 0, wind: 3.1 },
      { time: "2026-01-01T01:00", temp: null, precip: 0.4, wind: 2 },
    ]);
  });
  it("形が違えば WeatherFetchError", () => {
    expect(() => parseHourly({})).toThrow(WeatherFetchError);
    expect(() => parseHourly({ hourly: { time: ["a"], temperature_2m: [], precipitation: [1], wind_speed_10m: [1] } })).toThrow(
      WeatherFetchError,
    );
  });
});

describe("fetchHourly（HTTP を注入）", () => {
  it("HTTP のエラーは理由つきの WeatherFetchError", async () => {
    const fetchFn: FetchFn = async () =>
      new Response(JSON.stringify({ error: true, reason: "Parameter start_date is out of range" }), { status: 400 });
    await expect(fetchHourly(fetchFn, forecastUrl(26, 127))).rejects.toThrow("HTTP 400 を返しました: Parameter start_date is out of range");
  });
  it("通信の失敗は WeatherFetchError", async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(fetchHourly(fetchFn, forecastUrl(26, 127))).rejects.toThrow(WeatherFetchError);
  });
});

describe("E2E 用のモック", () => {
  it("過去 API: 指定の期間の時間別を返し、日平均は式どおり", async () => {
    const fetchFn = createMockFetch({ today: "2026-10-26" });
    const points = await fetchHourly(fetchFn, archiveUrl(26, 127, "2026-07-01", "2026-07-02"));
    expect(points).toHaveLength(48);
    const daily = hourlyToDaily(points);
    expect(daily.map((d) => d.date)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(daily[0].t_mean).toBeCloseTo(mockDailyMean("2026-07-01"), 1);
  });
  it("予報 API: 今日の past_days 日前から今日まで。過去 API より MOCK_FORECAST_BIAS_C 高い", async () => {
    const fetchFn = createMockFetch({ today: "2026-10-26" });
    const daily = hourlyToDaily(await fetchHourly(fetchFn, forecastUrl(26, 127)));
    expect(daily[0].date).toBe("2026-10-19");
    expect(daily.at(-1)?.date).toBe("2026-10-26");
    expect(daily[0].t_mean).toBeCloseTo(mockDailyMean("2026-10-19") + MOCK_FORECAST_BIAS_C, 1);
  });
  it("fault で指定の API を失敗させる", async () => {
    const fetchFn = createMockFetch({ today: "2026-10-26", fault: "archive" });
    await expect(fetchHourly(fetchFn, archiveUrl(26, 127, "2026-07-01", "2026-07-01"))).rejects.toThrow("HTTP 503");
    await expect(fetchHourly(fetchFn, forecastUrl(26, 127))).resolves.toHaveLength(8 * 24);
  });
});
