// Open-Meteo の取得（予報 API と過去 API）。HTTP は呼び出し側が渡す fetch を使う（テスト・E2E ではモックに差し替える）。
// API キー不要。単位: 気温 ℃、降水 mm、風速 m/s（wind_speed_unit=ms）。時刻は Asia/Tokyo の現地時刻（timezone=Asia/Tokyo）。

export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

// 予報 API で取る過去の日数（今日を含まない。past_days）。過去 API の確定値が出るまでの間を埋める
export const FORECAST_PAST_DAYS = 7;

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type WeatherApi = "forecast" | "archive";

// 時間別の 1 点（Open-Meteo の値そのまま。補正は aggregate.ts の applyOffset で加える）
export type HourlyPoint = {
  time: string; // 現地時刻 YYYY-MM-DDTHH:mm（Asia/Tokyo）
  temp: number | null;
  precip: number | null;
  wind: number | null;
};

const COMMON_PARAMS = {
  hourly: "temperature_2m,precipitation,wind_speed_10m",
  wind_speed_unit: "ms",
  timezone: "Asia/Tokyo",
};

function round4(n: number): string {
  return (Math.round(n * 10_000) / 10_000).toString();
}

export function forecastUrl(lat: number, lng: number, pastDays: number = FORECAST_PAST_DAYS): string {
  const q = new URLSearchParams({
    latitude: round4(lat),
    longitude: round4(lng),
    ...COMMON_PARAMS,
    past_days: String(pastDays),
    forecast_days: "1",
  });
  return `${FORECAST_URL}?${q}`;
}

export function archiveUrl(lat: number, lng: number, from: string, to: string): string {
  const q = new URLSearchParams({
    latitude: round4(lat),
    longitude: round4(lng),
    ...COMMON_PARAMS,
    start_date: from,
    end_date: to,
  });
  return `${ARCHIVE_URL}?${q}`;
}

export class WeatherFetchError extends Error {}

function numbers(v: unknown, length: number, name: string): (number | null)[] {
  if (!Array.isArray(v) || v.length !== length) {
    throw new WeatherFetchError(`Open-Meteo の応答の形が想定と違います（hourly.${name}）`);
  }
  return v.map((x) => (typeof x === "number" && Number.isFinite(x) ? x : null));
}

// Open-Meteo の JSON（hourly）を時間別の点の並びにする。形が違えば WeatherFetchError
export function parseHourly(json: unknown): HourlyPoint[] {
  const hourly = (json as { hourly?: Record<string, unknown> } | null)?.hourly;
  if (!hourly || !Array.isArray(hourly.time)) {
    throw new WeatherFetchError("Open-Meteo の応答の形が想定と違います（hourly.time がない）");
  }
  const time = hourly.time as unknown[];
  const temp = numbers(hourly.temperature_2m, time.length, "temperature_2m");
  const precip = numbers(hourly.precipitation, time.length, "precipitation");
  const wind = numbers(hourly.wind_speed_10m, time.length, "wind_speed_10m");
  return time.map((t, i) => {
    if (typeof t !== "string") throw new WeatherFetchError("Open-Meteo の応答の形が想定と違います（hourly.time）");
    return { time: t, temp: temp[i], precip: precip[i], wind: wind[i] };
  });
}

// URL を取得して時間別の点にする。HTTP のエラー・通信の失敗・形の違いは WeatherFetchError（理由つき）
export async function fetchHourly(fetchFn: FetchFn, url: string): Promise<HourlyPoint[]> {
  let res: Response;
  try {
    res = await fetchFn(url, { cache: "no-store" });
  } catch (e) {
    throw new WeatherFetchError(`Open-Meteo に接続できません（${(e as Error).message}）`);
  }
  if (!res.ok) {
    let reason = "";
    try {
      const body = (await res.json()) as { reason?: unknown };
      if (typeof body.reason === "string") reason = `: ${body.reason}`;
    } catch {
      // 本文が JSON でなければ理由なし
    }
    throw new WeatherFetchError(`Open-Meteo が HTTP ${res.status} を返しました${reason}`);
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new WeatherFetchError("Open-Meteo の応答が JSON ではありません");
  }
  return parseHourly(json);
}
