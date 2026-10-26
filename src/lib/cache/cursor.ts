// 差分の取り込み（offline-sync.md 5.4）のカーソル。純粋関数。
//
// - カーソルは (updated_at, id) の組。条件は「updated_at > c.updated_at または（updated_at = c.updated_at かつ id > c.id）」
//   （同時刻の行の取りこぼしを防ぐ。0017 の適用時に既存の行は全部同じ updated_at になるので、updated_at だけでは進めない）
// - updated_at は PostgREST が返す ISO 文字列（例 `2026-10-25T23:40:11.2073+00:00`。小数の末尾の 0 は省かれる）。
//   文字列の比較では桁がずれるので、マイクロ秒の整数にして比べる
// - 取り込みの開始時はカーソルを少し戻す（LOOKBACK_MS）。updated_at はトランザクションの開始時刻（now()）なので、
//   長いトランザクションが後からコミットした行は、先に進んだカーソルより古い時刻を持つことがある。戻した分は id で上書きされるだけ
import type { CacheTable, CachedRowBase, SyncCursor } from "./types";

export const PAGE_SIZE = 1000; // PostgREST の上限（max-rows）
export const LOOKBACK_MS = 2 * 60 * 1000;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const TS_RE = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

// ISO の timestamptz をエポックからのマイクロ秒にする（Number で 2^53 未満に収まる）
export function timestampMicros(ts: string): number {
  const m = TS_RE.exec(ts.trim());
  if (!m) {
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) throw new Error(`日時を解釈できません: ${ts}`);
    return ms * 1000;
  }
  const [, base, frac = "", tzRaw = "Z"] = m;
  const tz = tzRaw === "Z" ? "Z" : /^[+-]\d{2}$/.test(tzRaw) ? `${tzRaw}:00` : tzRaw.length === 5 ? `${tzRaw.slice(0, 3)}:${tzRaw.slice(3)}` : tzRaw;
  const ms = Date.parse(`${base.replace(" ", "T")}${tz}`);
  if (Number.isNaN(ms)) throw new Error(`日時を解釈できません: ${ts}`);
  const micros = Number((frac + "000000").slice(0, 6));
  return ms * 1000 + micros;
}

export function compareTimestamps(a: string, b: string): number {
  return Math.sign(timestampMicros(a) - timestampMicros(b));
}

// (updated_at, id) の組の比較
export function compareCursor(a: { updated_at: string; id: string }, b: { updated_at: string; id: string }): number {
  return compareTimestamps(a.updated_at, b.updated_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// 行がカーソルより後か（取り込む対象か）。カーソルが null（初回）なら全部
export function isAfterCursor(row: { updated_at: string; id: string }, cursor: { updated_at: string; id: string } | null): boolean {
  return cursor === null || compareCursor(row, cursor) > 0;
}

// 取り込んだページの行でカーソルを進める（前のカーソルより後ろにしか動かさない）。行が無ければ前のまま
export function advanceCursor(table: CacheTable, cursor: SyncCursor | null, rows: readonly CachedRowBase[]): SyncCursor | null {
  let best: SyncCursor | null = cursor;
  for (const r of rows) {
    if (best === null || compareCursor(r, best) > 0) best = { table, updated_at: r.updated_at, id: r.id };
  }
  return best;
}

// 取り込みの開始位置: 保存したカーソルを LOOKBACK_MS だけ戻す（id は最小）。カーソルが無ければ null（全件）
export function startCursor(cursor: SyncCursor | null, lookbackMs: number = LOOKBACK_MS): SyncCursor | null {
  if (cursor === null) return null;
  const micros = timestampMicros(cursor.updated_at) - lookbackMs * 1000;
  return { table: cursor.table, updated_at: microsToIso(micros), id: ZERO_UUID };
}

export function microsToIso(micros: number): string {
  const ms = Math.floor(micros / 1000);
  const rest = micros - ms * 1000;
  const iso = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  return `${iso.slice(0, 23)}${String(rest).padStart(3, "0")}+00:00`;
}

// PostgREST の or フィルタ（supabase-js の .or() に渡す）。値は二重引用符で囲む（: . , を含むため）。
// カーソルが null（初回）なら条件なし（null）。組織の条件は書かない（RLS が自組織に絞る）
export function cursorFilter(cursor: { updated_at: string; id: string } | null): string | null {
  if (cursor === null) return null;
  const ts = `"${cursor.updated_at}"`;
  return `updated_at.gt.${ts},and(updated_at.eq.${ts},id.gt.${cursor.id})`;
}

// ページの取得を続けるか（件数が上限に達したら次のページがありうる）
export function hasNextPage(rowCount: number, pageSize: number = PAGE_SIZE): boolean {
  return rowCount >= pageSize;
}
