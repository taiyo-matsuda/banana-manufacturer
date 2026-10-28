// 推定と提案の再計算の入口（3-3 の収穫予測日 → 3-4 の提案）。提案の収穫期のルールは最新の収穫予測日（latest_estimates）を
// 使うので、必ず収穫予測日を先に計算してから提案を評価する。呼び出し側（Route Handler・Server Action・Cron）は
// recomputeHarvestEstimates の代わりにこれを呼ぶ。範囲（scope）は src/lib/prediction/recompute.ts と同じ。
import type { SupabaseClient } from "@supabase/supabase-js";
import { recomputeHarvestEstimates, type RecomputeResult, type RecomputeScope } from "./prediction/recompute";
import { recomputeRecommendations, type RecommendationResult } from "./recommendations/recompute";

export type DerivedResult = RecomputeResult & { recommendations: RecommendationResult };

export async function recomputeDerived(db: SupabaseClient, scope: RecomputeScope, options: { now?: Date } = {}): Promise<DerivedResult> {
  const harvest = await recomputeHarvestEstimates(db, scope, options);
  const recommendations = await recomputeRecommendations(db, scope, options);
  return { ...harvest, recommendations };
}

// 例外を投げずにログへ（記録・設定の保存そのものは成功させる。推定・提案は次の再計算で追いつく）
export async function recomputeDerivedQuietly(db: SupabaseClient, scope: RecomputeScope, label: string): Promise<DerivedResult | null> {
  try {
    const r = await recomputeDerived(db, scope);
    if (r.errors.length > 0) console.error(`harvest recompute (${label}) errors`, r.errors);
    if (r.recommendations.errors.length > 0) console.error(`recommendations (${label}) errors`, r.recommendations.errors);
    return r;
  } catch (e) {
    console.error(`recompute (${label}) failed`, e);
    return null;
  }
}
