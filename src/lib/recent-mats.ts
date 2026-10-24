// ホームの「最近開いた株」（UX-1）。株の詳細を開いたときに端末の localStorage に直近 5 件を残す。
// サーバーには保存しない（端末ごとの利便性のための情報で、事実の記録ではない）。
// ここは純粋な関数だけ（UI・localStorage に依存しない）。読み書きは src/components/app/ の部品が行う。

export type RecentMat = {
  id: string;
  code: string;
  fieldName: string | null;
  // ISO 8601。並べ替えには使わず（配列の順が新しい順）、表示や将来の掃除のために残す
  openedAt: string;
};

export const RECENT_MATS_KEY = "recent-mats";
export const RECENT_MATS_MAX = 5;

// localStorage の生の値を安全に配列へ。壊れていたら空にする（画面を落とさない）
export function parseRecentMats(raw: string | null | undefined): RecentMat[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RecentMat[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.code !== "string") continue;
    out.push({
      id: r.id,
      code: r.code,
      fieldName: typeof r.fieldName === "string" ? r.fieldName : null,
      openedAt: typeof r.openedAt === "string" ? r.openedAt : "",
    });
  }
  return out;
}

// 先頭に追加し、同じ株は 1 つにまとめ、max 件に切る（新しい順）
export function pushRecentMat(list: RecentMat[], item: RecentMat, max = RECENT_MATS_MAX): RecentMat[] {
  const rest = list.filter((m) => m.id !== item.id);
  return [item, ...rest].slice(0, Math.max(0, max));
}
