// 葉数の計算。要件: docs/01_requirements.md 5.1
//
// 累計葉数（出蕾予測用）= 初期葉数 + Σ leaves_new
// 検算: 累計 ≒ leaves_current（最新）+ Σ leaves_removed

export type LeafObservation = {
  type: "leaves_new" | "leaves_current";
  value: number;
  observedAt: Date;
};

export type LeavesRemovedEvent = {
  count: number;
  occurredAt: Date;
};

/** 初期葉数と leaves_new の観測から累計葉数を求める */
export function cumulativeLeaves(
  initialLeafCount: number,
  observations: LeafObservation[],
): number {
  const added = observations
    .filter((o) => o.type === "leaves_new")
    .reduce((sum, o) => sum + o.value, 0);
  return initialLeafCount + added;
}

/**
 * 検算用の累計: 最新の leaves_current + それまでに除去した葉の合計。
 * leaves_current の観測がなければ null。
 */
export function cumulativeLeavesByCheck(
  observations: LeafObservation[],
  removed: LeavesRemovedEvent[],
): number | null {
  const current = observations
    .filter((o) => o.type === "leaves_current")
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0];
  if (!current) return null;
  const removedTotal = removed
    .filter((r) => r.occurredAt.getTime() <= current.observedAt.getTime())
    .reduce((sum, r) => sum + r.count, 0);
  return current.value + removedTotal;
}

/** 2つの累計の差が閾値以上なら「確認」が必要 */
export const LEAF_CHECK_THRESHOLD = 3;

export function needsLeafCheck(
  cumulative: number,
  byCheck: number | null,
  threshold = LEAF_CHECK_THRESHOLD,
): boolean {
  if (byCheck === null) return false;
  return Math.abs(cumulative - byCheck) >= threshold;
}

/** 検算のずれが閾値以上のときの警告文。ずれがなければ null（画面はこの文言をそのまま出す） */
export function leafCheckWarning(
  cumulative: number,
  byCheck: number | null,
  threshold = LEAF_CHECK_THRESHOLD,
): string | null {
  if (!needsLeafCheck(cumulative, byCheck, threshold)) return null;
  return `確認してください（累計 ${cumulative}、検算 ${byCheck}）`;
}
