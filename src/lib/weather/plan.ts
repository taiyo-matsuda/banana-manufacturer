// 取り込みの計画: どの日を過去 API で取り直すか（欠けた日の検出）、予報 API の値で書いてよい日はどれか。純粋関数。
//
// 保存の約束（data-model.md weather_hourly / weather_daily）:
// - 1 日 1 行（source = 'open-meteo'）。api = 'forecast'（予報 API の暫定値）/ 'archive'（過去 API の確定値）
// - 過去 API は数日遅れで確定する。直近 ARCHIVE_LAG_DAYS 日は予報 API の値で埋め、それより古い日は過去 API の値で上書きする
// - temperature_offset_c は保存時に加えた補正。圃場の補正と違う行は取り直す
import { addDays, daysBetween, eachDate, normalsRange } from "./dates";
import { FORECAST_PAST_DAYS } from "./open-meteo";

// 過去 API で確定値を取りにいく日: 今日から この日数より前（今日が 10/26 なら 10/21 以前）
export const ARCHIVE_LAG_DAYS = 5;
// 過去 API への 1 回の要求の最大日数（応答の大きさと、時間切れで途中まで進められるように）
export const ARCHIVE_CHUNK_DAYS = 366;

export type ExistingDay = { api: "forecast" | "archive"; offset: number };

export type PlanInput = {
  today: string; // 日本時間の今日
  // 埋めるべき開始日: 圃場の登録日と、最も古い茎の started_at の早い方
  fillStart: string;
  // 平年値の材料（過去 10 年分）も取るか（日次の取り込み・手動の取り込みは true、登録時は false）
  includeNormals: boolean;
  existing: ReadonlyMap<string, ExistingDay>;
  offset: number; // 圃場の現在の補正
};

export type DateRange = { from: string; to: string };

export type SyncPlan = {
  // 過去 API で取る期間（新しい順。埋めるべき期間 → 平年値の材料の順）。各期間は ARCHIVE_CHUNK_DAYS 日以内
  archiveRanges: DateRange[];
  // 予報 API の値で日次を書いてよい日（確定値がまだない日）。予報 API は毎回呼ぶ（直近の日を更新するため）
  forecastDates: Set<string>;
  // 時間別も保存する開始日（これより前は日次だけ。10 年分は日次だけ）
  hourlyFrom: string;
  // 欠けている（または取り直しが要る）日の数（過去 API の対象）
  missingCount: number;
};

function isConfirmed(day: ExistingDay | undefined, offset: number): boolean {
  return day !== undefined && day.api === "archive" && day.offset === offset;
}

// dates（昇順）のうち、過去 API で取り直しが要る日を、連続した期間にまとめる（ARCHIVE_CHUNK_DAYS 日ずつに分ける）
export function missingRanges(
  dates: readonly string[],
  existing: ReadonlyMap<string, ExistingDay>,
  offset: number,
  chunkDays: number = ARCHIVE_CHUNK_DAYS,
): DateRange[] {
  const ranges: DateRange[] = [];
  let current: DateRange | null = null;
  let length = 0;
  for (const d of dates) {
    if (isConfirmed(existing.get(d), offset)) {
      current = null;
      continue;
    }
    if (current && current.to === addDays(d, -1) && length < chunkDays) {
      current.to = d;
      length++;
    } else {
      current = { from: d, to: d };
      length = 1;
      ranges.push(current);
    }
  }
  return ranges;
}

export function planSync(input: PlanInput): SyncPlan {
  const { today, fillStart, includeNormals, existing, offset } = input;
  const yesterday = addDays(today, -1);
  const archiveEnd = addDays(today, -ARCHIVE_LAG_DAYS);

  // 過去 API の対象になりうる日（確定値が出ている archiveEnd まで）:
  // - 埋めるべき期間（登録日 / 最も古い茎 〜）
  // - 平年値の材料（今年 1/1 の 10 年前 〜 昨年末。includeNormals のとき）
  // - すでに予報 API の暫定値（または補正の違う値）が入っている日（登録前の直近の日など）
  const candidates = new Set<string>();
  if (fillStart <= archiveEnd) for (const d of eachDate(fillStart, archiveEnd)) candidates.add(d);
  if (includeNormals) {
    const { from, to } = normalsRange(today);
    const normalsEnd = to < archiveEnd ? to : archiveEnd;
    if (from <= normalsEnd) for (const d of eachDate(from, normalsEnd)) candidates.add(d);
  }
  for (const [d, day] of existing) {
    if (d <= archiveEnd && !isConfirmed(day, offset)) candidates.add(d);
  }
  const sorted = [...candidates].sort();
  // 新しい順（埋めるべき期間 → 平年値の材料）。時間切れで途中までしか進まなくても、新しい日から埋まる
  const archiveRanges = missingRanges(sorted, existing, offset).reverse();

  // 予報 API（past_days）が返す直近の日のうち、確定値がまだない日
  const forecastDates = new Set<string>();
  for (const d of eachDate(addDays(today, -FORECAST_PAST_DAYS), yesterday)) {
    if (!isConfirmed(existing.get(d), offset)) forecastDates.add(d);
  }

  const missingCount = archiveRanges.reduce((n, r) => n + daysBetween(r.from, r.to) + 1, 0);
  return { archiveRanges, forecastDates, hourlyFrom: fillStart, missingCount };
}

// 埋めるべき開始日: 圃場の登録日（日本時間）と、最も古い茎の started_at の早い方
export function fillStartDate(fieldCreatedDate: string, oldestStemStartedAt: string | null): string {
  if (oldestStemStartedAt && oldestStemStartedAt < fieldCreatedDate) return oldestStemStartedAt;
  return fieldCreatedDate;
}
