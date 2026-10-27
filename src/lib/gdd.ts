// 積算温度（GDD）と平年値（prediction.md 1 章、3-2）。UI に依存しない純粋関数。
//
// - 日次 GDD: その日の時間別の気温が 24 時間そろっていれば 平均(max(0, 気温 − 基準温度))（時間ごとに 0 で切ってから平均）、
//   なければ max(0, 日平均 − 基準温度)。どちらを使ったか（method）を返す
// - 期間の積算: 「開始日の翌日から終了日まで」の日次 GDD の合計。開始日当日は含めない。気温の無い日は数えず、欠けた日数を返す
// - 平年値: 過去 10 年の同じ月日の日平均気温の平均。2/29 は、その年に 2/29 の値があればそれを、無ければ
//   その年の 2/28 と 3/1 の平均を 1 年分のサンプルとする。サンプルが 3 年未満の月日は null。使った年の範囲（版）を返す
// - 基準温度: 圃場 × 品種の上書き（field_cultivar_params.base_temp_c）→ 品種の既定（cultivars.base_temp_c）→ 14℃
import { addDays, daysBetween, eachDate } from "./weather/dates";

export const DEFAULT_BASE_TEMP_C = 14;
export const DEFAULT_TARGET_GDD = 900;
// 基準温度・目標積算温度として受け付ける範囲（0020 の検査と同じ）
export const BASE_TEMP_MIN_C = 5;
export const BASE_TEMP_MAX_C = 20;
export const TARGET_GDD_MIN = 100;
export const TARGET_GDD_MAX = 5000;
// 時間別の気温を使うのは 24 時間そろった日だけ（欠けた時間があれば日平均で計算する）
export const HOURS_FOR_HOURLY_GDD = 24;
// 平年値: この年数に満たない月日は null
export const NORMALS_MIN_YEARS = 3;

export type GddMethod = "hourly" | "daily";
export type DailyGdd = { gdd: number; method: GddMethod };

// 1 日の GDD。時間別（24 時間そろったもの）があればそれ、なければ日平均。どちらも無ければ null（欠けた日）
export function dailyGdd(
  day: { tMean: number | null; hourlyTemps?: readonly number[] | null },
  baseTempC: number,
): DailyGdd | null {
  const hourly = day.hourlyTemps;
  if (hourly && hourly.length === HOURS_FOR_HOURLY_GDD) {
    const sum = hourly.reduce((s, t) => s + Math.max(0, t - baseTempC), 0);
    return { gdd: sum / hourly.length, method: "hourly" };
  }
  if (day.tMean === null || Number.isNaN(day.tMean)) return null;
  return { gdd: Math.max(0, day.tMean - baseTempC), method: "daily" };
}

export type DailyTemp = { date: string; tMean: number | null };
export type HourlyDay = { date: string; temps: readonly number[] };

export type GddPeriod = {
  from: string; // 積算の初日（開始日の翌日）
  to: string; // 積算の最終日（終了日。含む）
  total: number; // 日次 GDD の合計（丸めない）
  days: number; // 期間の日数（from〜to）
  countedDays: number; // 気温があって数えた日数
  missingDays: number; // 気温が無く数えなかった日数
  missingDates: string[];
  hourlyDays: number; // 時間別で計算した日数
  dailyDays: number; // 日平均で計算した日数
};

// 開始日の翌日から終了日までの積算。終了日 ≤ 開始日なら空の期間（合計 0）
export function accumulateGdd(input: {
  startDate: string;
  endDate: string;
  daily: readonly DailyTemp[];
  hourly?: readonly HourlyDay[];
  baseTempC: number;
}): GddPeriod {
  const { startDate, endDate, baseTempC } = input;
  const from = addDays(startDate, 1);
  const dailyByDate = new Map(input.daily.map((d) => [d.date, d.tMean]));
  const hourlyByDate = new Map((input.hourly ?? []).map((h) => [h.date, h.temps]));
  let total = 0;
  let hourlyDays = 0;
  let dailyDays = 0;
  const missingDates: string[] = [];
  const dates = eachDate(from, endDate);
  for (const date of dates) {
    const g = dailyGdd({ tMean: dailyByDate.get(date) ?? null, hourlyTemps: hourlyByDate.get(date) ?? null }, baseTempC);
    if (!g) {
      missingDates.push(date);
      continue;
    }
    total += g.gdd;
    if (g.method === "hourly") hourlyDays++;
    else dailyDays++;
  }
  return {
    from,
    to: endDate,
    total,
    days: dates.length,
    countedDays: hourlyDays + dailyDays,
    missingDays: missingDates.length,
    missingDates,
    hourlyDays,
    dailyDays,
  };
}

// ---------------------------------------------------------------------------
// 平年値

export type NormalsVersion = {
  fromYear: number;
  toYear: number;
  years: number; // 使った年の数（材料にあった年）
};

export type Normals = {
  // 月日（MM-DD）→ 平年の日平均気温。サンプルが NORMALS_MIN_YEARS 年未満なら null
  byMonthDay: ReadonlyMap<string, number | null>;
  // 材料に使った年の範囲。材料が無ければ null
  version: NormalsVersion | null;
};

const monthDayOf = (date: string) => date.slice(5, 10);

// 全 366 の月日（01-01〜12-31、02-29 を含む）
const ALL_MONTH_DAYS = eachDate("2000-01-01", "2000-12-31").map(monthDayOf);

// 材料（過去の日別の日平均）から平年値を作る。材料は呼び出し側が選ぶ（通常は normalsRange の 10 年分）
export function buildNormals(daily: readonly DailyTemp[], minYears: number = NORMALS_MIN_YEARS): Normals {
  const byDate = new Map<string, number>();
  for (const d of daily) if (d.tMean !== null && !Number.isNaN(d.tMean)) byDate.set(d.date, d.tMean);
  const years = [...new Set([...byDate.keys()].map((d) => Number(d.slice(0, 4))))].sort((a, b) => a - b);

  // 月日 → 年ごとのサンプル
  const samples = new Map<string, number[]>();
  const push = (md: string, v: number) => {
    const list = samples.get(md);
    if (list) list.push(v);
    else samples.set(md, [v]);
  };
  for (const [date, t] of byDate) {
    const md = monthDayOf(date);
    if (md !== "02-29") push(md, t);
  }
  // 2/29: その年の 2/29 があればそれ、無ければ 2/28 と 3/1 の平均（両方あるとき）
  for (const y of years) {
    const leap = byDate.get(`${y}-02-29`);
    if (leap !== undefined) {
      push("02-29", leap);
      continue;
    }
    const feb28 = byDate.get(`${y}-02-28`);
    const mar1 = byDate.get(`${y}-03-01`);
    if (feb28 !== undefined && mar1 !== undefined) push("02-29", (feb28 + mar1) / 2);
  }

  const byMonthDay = new Map<string, number | null>();
  for (const md of ALL_MONTH_DAYS) {
    const list = samples.get(md) ?? [];
    byMonthDay.set(md, list.length >= minYears ? list.reduce((s, v) => s + v, 0) / list.length : null);
  }
  return {
    byMonthDay,
    version: years.length > 0 ? { fromYear: years[0], toYear: years[years.length - 1], years: years.length } : null,
  };
}

// 日付（YYYY-MM-DD）の平年値。うるう年でない年の日付でも月日で引く
export function normalFor(normals: Normals, date: string): number | null {
  return normals.byMonthDay.get(monthDayOf(date)) ?? null;
}

// 平年値の版の文字列（estimates.inputs に残す。3-3）
export function normalsVersionLabel(version: NormalsVersion | null): string | null {
  return version ? `normals-${version.fromYear}-${version.toYear}` : null;
}

// ---------------------------------------------------------------------------
// 基準温度の解決

export type BaseTempSource = "field" | "cultivar" | "default";

export function resolveBaseTemp(input: {
  fieldOverride: number | null | undefined;
  cultivarDefault: number | null | undefined;
}): { value: number; source: BaseTempSource } {
  if (input.fieldOverride !== null && input.fieldOverride !== undefined) return { value: Number(input.fieldOverride), source: "field" };
  if (input.cultivarDefault !== null && input.cultivarDefault !== undefined)
    return { value: Number(input.cultivarDefault), source: "cultivar" };
  return { value: DEFAULT_BASE_TEMP_C, source: "default" };
}

// ---------------------------------------------------------------------------
// 茎の画面の「出蕾から N 日、積算温度 X ℃・日」

export type StemGdd = {
  budDate: string;
  endDate: string; // 日数の終わり（今日、または収穫日・終了日）
  ended: "harvested" | "ended" | null; // 収穫・終了した茎は その日まで
  elapsedDays: number; // 出蕾から endDate までの日数
  accumulatedTo: string; // 積算の最終日（栽培中は昨日。今日の気温はまだそろわない）
  total: number; // 積算温度（丸めない）
  rounded: number; // 表示用（四捨五入）
  baseTempC: number;
  baseTempSource: BaseTempSource;
  missingDays: number;
  // 気温がまだ取り込まれていない（取り込みの成功が一度も無く、期間に気温の行も無い）
  notImported: boolean;
};

// 積算する期間の決め方: 栽培中の茎は 出蕾日の翌日〜昨日（今日の日次は取り込まれていない）。
// 収穫した茎は収穫日まで、それ以外で終わった茎は終了日まで（両端は accumulateGdd と同じく開始日を含まず終了日を含む）
export function stemGddPeriod(input: {
  budDate: string;
  today: string;
  harvestedAt: string | null;
  endedAt: string | null;
}): { endDate: string; accumulateTo: string; ended: StemGdd["ended"] } {
  const { today, harvestedAt, endedAt } = input;
  if (harvestedAt) return { endDate: harvestedAt, accumulateTo: minDate(harvestedAt, addDays(today, -1)), ended: "harvested" };
  if (endedAt) return { endDate: endedAt, accumulateTo: minDate(endedAt, addDays(today, -1)), ended: "ended" };
  return { endDate: today, accumulateTo: addDays(today, -1), ended: null };
}

function minDate(a: string, b: string): string {
  return a < b ? a : b;
}

export function stemGdd(input: {
  budDate: string;
  today: string;
  harvestedAt: string | null;
  endedAt: string | null;
  daily: readonly DailyTemp[];
  hourly?: readonly HourlyDay[];
  fieldBaseTempC: number | null;
  cultivarBaseTempC: number | null;
  weatherEverSynced: boolean;
}): StemGdd {
  const { budDate } = input;
  const period = stemGddPeriod(input);
  const base = resolveBaseTemp({ fieldOverride: input.fieldBaseTempC, cultivarDefault: input.cultivarBaseTempC });
  const acc = accumulateGdd({
    startDate: budDate,
    endDate: period.accumulateTo,
    daily: input.daily,
    hourly: input.hourly,
    baseTempC: base.value,
  });
  return {
    budDate,
    endDate: period.endDate,
    ended: period.ended,
    elapsedDays: Math.max(0, daysBetween(budDate, period.endDate)),
    accumulatedTo: period.accumulateTo,
    total: acc.total,
    rounded: Math.round(acc.total),
    baseTempC: base.value,
    baseTempSource: base.source,
    missingDays: acc.missingDays,
    notImported: !input.weatherEverSynced && acc.countedDays === 0,
  };
}

// 基準温度の表示（14 → "14"、13.5 → "13.5"）
export function formatTempC(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
