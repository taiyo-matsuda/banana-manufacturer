// 気象の取り込みで使う日付の計算（YYYY-MM-DD の文字列。日付の境界は Asia/Tokyo）。純粋関数。

const jstDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// 日時 → 日本時間の日付（YYYY-MM-DD）
export function jstDateOf(at: Date | string): string {
  return jstDate.format(typeof at === "string" ? new Date(at) : at);
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isDateString(s: string): boolean {
  if (!DATE_PATTERN.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// 日付に n 日を足す（暦の上の計算。UTC の 0 時で数えるので時差・夏時間の影響を受けない）
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// from から to までの日数（to - from）。同じ日なら 0
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// from 〜 to（両端を含む）の日付の並び。from > to なら空
export function eachDate(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// 平年値の材料の期間: 今年 1/1 の 10 年前から昨年末まで（今日が 2026-10-26 なら 2016-01-01 〜 2025-12-31）
export const NORMALS_YEARS = 10;
export function normalsRange(today: string, years: number = NORMALS_YEARS): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  return { from: `${year - years}-01-01`, to: `${year - 1}-12-31` };
}
