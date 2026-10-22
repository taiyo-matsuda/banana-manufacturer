// 初期葉数の入力（文字列）の解釈。株の一括配置（placement.ts）と茎の登録（registration.ts）の両方から使う
// （registration.ts は placement.ts の isValidDateString を使うので、循環を避けるためここに分ける）

export type LeafCountParse = { ok: true; value: number | null } | { ok: false; error: string };

export const INITIAL_LEAF_COUNT_ERROR = "初期葉数は 0 以上の整数で入力してください";

// 0 以上の整数にする。空は「指定なし」（null）
export function parseInitialLeafCount(input: string | null | undefined): LeafCountParse {
  const s = (input ?? "").trim();
  if (s === "") return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false, error: INITIAL_LEAF_COUNT_ERROR };
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < 0) return { ok: false, error: INITIAL_LEAF_COUNT_ERROR };
  return { ok: true, value: n };
}
