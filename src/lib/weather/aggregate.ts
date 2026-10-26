// 時間別 → 日次の集計と、圃場の気温補正（temperature_offset_c）の加算。純粋関数。
// 日付の境界は Asia/Tokyo（Open-Meteo に timezone=Asia/Tokyo を渡すので、time は現地時刻 YYYY-MM-DDTHH:mm）。
import type { HourlyPoint } from "./open-meteo";

// 1 日の時間別の点がこの数そろっていない日は、日次にしない（過去 API の確定前の日は null が返る）
export const HOURS_PER_DAY = 24;

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// 気温に補正を加える（降水・風速は変えない）。補正は 0.1 ℃ 単位
export function applyOffset(points: readonly HourlyPoint[], offsetC: number): HourlyPoint[] {
  if (!offsetC) return points.map((p) => ({ ...p }));
  return points.map((p) => ({ ...p, temp: p.temp === null ? null : p.temp + offsetC }));
}

export type DailyWeather = {
  date: string; // YYYY-MM-DD（Asia/Tokyo）
  t_mean: number;
  t_min: number;
  t_max: number;
  precip_mm: number | null; // 24 時間の降水の合計。欠けた時間があれば null
  wind_max_ms: number | null; // 時間別の風速（10m）の最大。値がなければ null
};

// 時間別 → 日次（日平均・最低・最高・降水合計・最大風速）。気温が 24 時間そろった日だけ返す（日付の昇順）
export function hourlyToDaily(points: readonly HourlyPoint[]): DailyWeather[] {
  const byDate = new Map<string, HourlyPoint[]>();
  for (const p of points) {
    const date = p.time.slice(0, 10);
    const list = byDate.get(date);
    if (list) list.push(p);
    else byDate.set(date, [p]);
  }
  const out: DailyWeather[] = [];
  for (const [date, list] of [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const temps = list.map((p) => p.temp).filter((t): t is number => t !== null);
    if (list.length !== HOURS_PER_DAY || temps.length !== HOURS_PER_DAY) continue;
    const precips = list.map((p) => p.precip);
    const winds = list.map((p) => p.wind).filter((w): w is number => w !== null);
    out.push({
      date,
      t_mean: round1(temps.reduce((s, t) => s + t, 0) / temps.length),
      t_min: round1(Math.min(...temps)),
      t_max: round1(Math.max(...temps)),
      precip_mm: precips.every((x) => x !== null)
        ? round1((precips as number[]).reduce((s, x) => s + x, 0))
        : null,
      wind_max_ms: winds.length > 0 ? round1(Math.max(...winds)) : null,
    });
  }
  return out;
}

// 時間別の点の時刻（現地時刻）→ timestamptz の文字列（+09:00）
export function hourlyTimestamp(time: string): string {
  return `${time}:00+09:00`;
}
