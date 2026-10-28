// ホームの「提案」の表示（3-4、screens.md 1）: 種類の名前、「実施した」で開く記録画面、期限順の並べ替え、期限の文言。純粋関数。
import { formatMonthDay } from "../prediction/harvest";
import { generationLabel } from "../stems/status";
import { daysBetween } from "../weather/dates";
import type { RecommendationKind } from "./rules";

export const RECOMMENDATION_KIND_LABELS: Record<RecommendationKind, string> = {
  bag: "袋掛け",
  debud: "摘蕾",
  harvest_window: "収穫期",
  fertilize_after_harvest: "収穫後の追肥",
  remove_dead_leaves: "枯葉処理",
  inspect: "確認",
};

export function recommendationKindLabel(kind: string): string {
  return RECOMMENDATION_KIND_LABELS[kind as RecommendationKind] ?? kind;
}

// 「実施した」で開く記録（茎の画面のイベント。?record= で記録のダイアログを開く）
const RECORD_EVENT: Partial<Record<RecommendationKind, string>> = {
  bag: "bagged",
  debud: "debudded",
  harvest_window: "harvested",
};

export type OpenRecommendationRow = {
  id: string;
  kind: string;
  target_type: string;
  target_id: string;
  due_at: string | null;
  reason: string | null;
  created_at: string;
  stem_id: string | null;
  generation: number | null;
  mat_id: string | null;
  mat_code: string | null;
  field_name: string | null;
};

export function recordHref(row: Pick<OpenRecommendationRow, "kind" | "stem_id" | "mat_id">): string | null {
  const event = RECORD_EVENT[row.kind as RecommendationKind];
  if (event && row.stem_id) return `/stems/${row.stem_id}?record=${event}`;
  if (row.stem_id) return `/stems/${row.stem_id}`;
  if (row.mat_id) return `/mats/${row.mat_id}`;
  return null;
}

// 対象の表示: 「A-001 親」（茎）、「A-001」（株）
export function targetLabel(row: Pick<OpenRecommendationRow, "mat_code" | "generation">): string {
  const code = row.mat_code ?? "（不明な株）";
  return row.generation === null ? code : `${code} ${generationLabel(row.generation)}`;
}

// 期限順（期限なしは最後）、同じ期限は作られた順
export function sortRecommendations<T extends Pick<OpenRecommendationRow, "due_at" | "created_at" | "id">>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.due_at !== b.due_at) {
      if (a.due_at === null) return 1;
      if (b.due_at === null) return -1;
      return a.due_at.localeCompare(b.due_at);
    }
    return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  });
}

// 「期限 10月29日（あと 1 日）」「期限 10月20日（8 日過ぎ）」「期限 今日（10月28日）」
export function dueLabel(dueAt: string | null, today: string): string {
  if (!dueAt) return "期限なし";
  const d = daysBetween(today, dueAt);
  const md = formatMonthDay(dueAt);
  if (d === 0) return `期限 今日（${md}）`;
  if (d > 0) return `期限 ${md}（あと ${d} 日）`;
  return `期限 ${md}（${-d} 日過ぎ）`;
}
