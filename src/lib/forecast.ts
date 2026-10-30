// 予測一覧（3-6、画面 7、prediction.md 8 章）: 出蕾済みの茎の最新の収穫予測日（latest_estimates）を週ごとに数える。純粋関数。
//
// - 週は月曜始まり（日本時間の暦の日付。value_date は日付なので時差の計算はいらない）
// - 数えるのは status = flowered の茎だけ（lost・収穫済み・出蕾前は数えない）
// - 「要確認」（severe の被害。茎・株・圃場、prediction.md 7 章）の茎は、予測日の週の「要確認（別枠）」に数え、本数には入れない
// - 予測できなかった茎（理由付きの行、value_date が null）と、まだ推定の無い茎は週に数えず、「予測できない茎」に理由と並べる
// - 予測日が今週より前（予測日を過ぎてまだ収穫の記録が無い）の茎は「予測日を過ぎた」の 1 行にまとめる
// - 週の表は、茎が 1 本以上ある週だけを予測日の順に並べる（空の週は出さない。予測は最長 730 日先まであり、空の行で表が伸びるため）
// - lower〜upper が 3 週以上にまたがる茎は「不確実」にしない（幅は目標 GDD の ±10% の固定の幅で、実測のばらつきではないため。
//   冬は 1 日の GDD が小さく幅が 4〜6 週になり、入れるとほぼすべての茎が別枠になる。prediction.md 8 章）

import { PROJECTION_MAX_DAYS, type HarvestDisplay, type UnavailableReason } from "./prediction/harvest";
import { addDays } from "./weather/dates";

export type ForecastStemInput = {
  stemId: string;
  matId: string;
  matCode: string;
  fieldId: string;
  fieldName: string;
  generation: number;
  status: string;
  // 出蕾日（stems.bud_emerged_at、YYYY-MM-DD）
  budDate: string | null;
  // 最新の推定（harvestDisplayFrom の結果）。まだ推定が無ければ null
  estimate: HarvestDisplay | null;
};

export type ForecastRow = {
  stemId: string;
  matId: string;
  matCode: string;
  fieldId: string;
  fieldName: string;
  generation: number;
  budDate: string | null;
  valueDate: string;
  lowerDate: string;
  upperDate: string;
  weekStart: string;
  needsReview: boolean;
  overdue: boolean;
};

export type ForecastUnavailableRow = {
  stemId: string;
  matId: string;
  matCode: string;
  fieldId: string;
  fieldName: string;
  generation: number;
  budDate: string | null;
  // pending = まだ推定が無い（再計算が届いていない）
  reason: UnavailableReason | "pending";
  reasonDate: string | null;
  needsReview: boolean;
};

export type ForecastWeek = {
  weekStart: string; // 月曜
  weekEnd: string; // 日曜
  count: number; // 要確認を除く本数
  needsReview: number; // 要確認（別枠）
};

export type ForecastSummary = {
  thisWeekStart: string;
  weeks: ForecastWeek[];
  overdue: { count: number; needsReview: number };
  total: { count: number; needsReview: number };
  rows: ForecastRow[];
  unavailable: ForecastUnavailableRow[];
};

// その日を含む週の月曜（YYYY-MM-DD）。暦の上の計算（UTC の 0 時で曜日を出す）
export function weekStartOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = 日曜
  return addDays(date, -((day + 6) % 7));
}

const byCode = (a: { matCode: string; generation: number }, b: { matCode: string; generation: number }) =>
  a.matCode.localeCompare(b.matCode, "ja") || a.generation - b.generation;

export function buildForecast(stems: readonly ForecastStemInput[], today: string): ForecastSummary {
  const thisWeekStart = weekStartOf(today);
  const rows: ForecastRow[] = [];
  const unavailable: ForecastUnavailableRow[] = [];

  for (const s of stems) {
    if (s.status !== "flowered") continue;
    const base = {
      stemId: s.stemId,
      matId: s.matId,
      matCode: s.matCode,
      fieldId: s.fieldId,
      fieldName: s.fieldName,
      generation: s.generation,
      budDate: s.budDate,
    };
    const e = s.estimate;
    if (!e) {
      unavailable.push({ ...base, reason: "pending", reasonDate: null, needsReview: false });
      continue;
    }
    if (e.state === "unavailable") {
      unavailable.push({ ...base, reason: e.reason, reasonDate: e.date, needsReview: e.needsReview });
      continue;
    }
    const weekStart = weekStartOf(e.valueDate);
    rows.push({
      ...base,
      valueDate: e.valueDate,
      lowerDate: e.lowerDate,
      upperDate: e.upperDate,
      weekStart,
      needsReview: e.needsReview,
      overdue: weekStart < thisWeekStart,
    });
  }

  rows.sort((a, b) => (a.valueDate < b.valueDate ? -1 : a.valueDate > b.valueDate ? 1 : byCode(a, b)));
  unavailable.sort(byCode);

  const weekMap = new Map<string, ForecastWeek>();
  const overdue = { count: 0, needsReview: 0 };
  const total = { count: 0, needsReview: 0 };
  for (const r of rows) {
    const key = r.needsReview ? "needsReview" : "count";
    total[key] += 1;
    if (r.overdue) {
      overdue[key] += 1;
      continue;
    }
    let w = weekMap.get(r.weekStart);
    if (!w) {
      w = { weekStart: r.weekStart, weekEnd: addDays(r.weekStart, 6), count: 0, needsReview: 0 };
      weekMap.set(r.weekStart, w);
    }
    w[key] += 1;
  }
  const weeks = [...weekMap.values()].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));

  return { thisWeekStart, weeks, overdue, total, rows, unavailable };
}

// 週の呼び名: 今週・来週・再来週、それ以外は null
export function weekRelativeLabel(weekStart: string, thisWeekStart: string): string | null {
  if (weekStart === thisWeekStart) return "今週";
  if (weekStart === addDays(thisWeekStart, 7)) return "来週";
  if (weekStart === addDays(thisWeekStart, 14)) return "再来週";
  return null;
}

// 予測できない茎の理由（短い文）
export function forecastUnavailableLabel(reason: ForecastUnavailableRow["reason"]): string {
  switch (reason) {
    case "pending":
      return "まだ計算されていません（茎の画面を開くと計算します）";
    case "no_normals":
      return "平年値の材料（過去の気温）が未取得";
    case "normals_gap":
      return "平年値が足りない（過去の気温が 3 年分そろっていない）";
    case "never_reaches":
      return `出蕾から ${PROJECTION_MAX_DAYS} 日以内に目標の積算温度に達しない`;
  }
}
