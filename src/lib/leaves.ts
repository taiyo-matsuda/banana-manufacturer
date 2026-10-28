// 葉数の計算。要件: docs/01_requirements.md 5.1、検算の式は prediction.md 6 章（3-5a）
//
// 累計葉数（出蕾予測用）= 初期葉数 + Σ leaves_new
// 検算（3-5a）: 最新の現在の葉数（leaves_current）を記録した「時点」で比べる。
//   - その時点の累計 = 初期葉数 + その時点以前の leaves_new
//   - 検算         = その現在の葉数 + その時点以前の枯葉処理（leaves_removed）の枚数
//   その時点より後の新葉・枯葉処理は入れない（次に現在の葉数を記録したときに検算し直す）。
// 「以前」は observed_at / occurred_at が検算の時点と同じか前（同じ時刻は含める）。
// 検算の時点は現在の葉数の observed_at。ただし日付だけで入れた記録（過去日の出蕾の生葉数。observed_at が
// 日本時間の 0:00 ちょうど）は「その日の終わり」とする（その日の新葉・枯葉処理を含める）。
//
// 茎の画面の警告・株の詳細の茎一覧・「確認」の提案（recommendations/rules.ts）はすべてこのファイルの leafCheck を使う。
// 入力は現在の値（superseded_by が null の行）だけにすること（呼び出し側で絞る）。

export type LeafObservation = {
  type: "leaves_new" | "leaves_current";
  value: number;
  observedAt: Date;
  id?: string; // 検算に使った現在の葉数の観測を返すため（同じ時刻の現在の葉数が複数あるときの順にも使う）
};

export type LeavesRemovedEvent = {
  count: number;
  occurredAt: Date;
};

/** 初期葉数と leaves_new の観測から累計葉数を求める */
export function cumulativeLeaves(
  initialLeafCount: number,
  observations: readonly LeafObservation[],
): number {
  const added = observations
    .filter((o) => o.type === "leaves_new")
    .reduce((sum, o) => sum + o.value, 0);
  return initialLeafCount + added;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * 検算の時点（ミリ秒）。現在の葉数の observed_at。日本時間の 0:00 ちょうど（日付だけで入れた記録）なら、その日の終わり。
 */
export function leafCheckPointMs(observedAt: Date): number {
  const t = observedAt.getTime();
  if ((t + JST_OFFSET_MS) % DAY_MS === 0) return t + DAY_MS - 1;
  return t;
}

/** 2つの累計の差が閾値以上なら「確認」が必要 */
export const LEAF_CHECK_THRESHOLD = 3;

export type LeafCheck = {
  observationId: string | null; // 検算に使った現在の葉数の観測（id を渡したとき）
  cumulative: number; // その時点の累計（初期葉数 + その時点以前の新葉）
  byCheck: number; // 検算（その現在の葉数 + その時点以前の枯葉処理）
  diff: number; // |cumulative - byCheck|
  needsCheck: boolean; // diff が閾値以上
};

/**
 * 検算。最新の現在の葉数（observed_at が最も新しい。同じ時刻なら id の大きいほう）の時点で、
 * その時点の累計と「現在の葉数 + その時点以前の枯葉処理」を比べる。現在の葉数の観測がなければ null。
 */
export function leafCheck(
  initialLeafCount: number,
  observations: readonly LeafObservation[],
  removed: readonly LeavesRemovedEvent[],
  threshold = LEAF_CHECK_THRESHOLD,
): LeafCheck | null {
  const current = observations
    .filter((o) => o.type === "leaves_current")
    .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime() || (b.id ?? "").localeCompare(a.id ?? ""))[0];
  if (!current) return null;
  const point = leafCheckPointMs(current.observedAt);
  const cumulative =
    initialLeafCount +
    observations
      .filter((o) => o.type === "leaves_new" && o.observedAt.getTime() <= point)
      .reduce((sum, o) => sum + o.value, 0);
  const byCheck =
    current.value +
    removed.filter((r) => r.occurredAt.getTime() <= point).reduce((sum, r) => sum + r.count, 0);
  const diff = Math.abs(cumulative - byCheck);
  return {
    observationId: current.id ?? null,
    cumulative,
    byCheck,
    diff,
    needsCheck: diff >= threshold,
  };
}

/** 検算のずれが閾値以上のときの警告文。ずれがなければ null（画面はこの文言をそのまま出す） */
export function leafCheckWarning(check: LeafCheck | null): string | null {
  if (!check?.needsCheck) return null;
  return `確認してください（記録時点の累計 ${check.cumulative}、検算 ${check.byCheck}）`;
}
