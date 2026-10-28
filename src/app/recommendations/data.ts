import { sortRecommendations, type OpenRecommendationRow } from "@/lib/recommendations/display";
import { RECOMMENDATION_PARAMS_COLUMNS, type RecommendationParamsRow, resolveRecommendationSettings, standardAmountLabel } from "@/lib/recommendations/settings";
import { createClient } from "@/lib/supabase/server";

// 一覧の 1 行。収穫後の追肥（3-5）は、今の圃場の標準量（未設定なら「圃場の標準量を設定してください」）を添える
export type RecommendationListRow = OpenRecommendationRow & { amount_label: string | null };

// open の提案（3-4）をビュー open_recommendations から期限順に読む。ホーム（上位 limit 件）と /recommendations（全件）で共通。
// total は open の全件数（ホームの「すべて見る（N 件）」）
export async function fetchOpenRecommendations(
  limit?: number,
): Promise<{ rows: RecommendationListRow[]; total: number; error: string | null }> {
  const supabase = await createClient();
  let q = supabase
    .from("open_recommendations")
    .select("id, kind, target_type, target_id, due_at, reason, created_at, stem_id, generation, mat_id, mat_code, field_id, field_name", {
      count: "exact",
    })
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (limit !== undefined) q = q.limit(limit);
  const { data, error, count } = await q;
  if (error) return { rows: [], total: 0, error: error.message };
  const sorted = sortRecommendations((data ?? []) as OpenRecommendationRow[]);

  // 収穫後の追肥の行の圃場の標準量（量は理由に焼き込まず、表示のたびに今の設定を読む）
  const fieldIds = [...new Set(sorted.filter((r) => r.kind === "fertilize_after_harvest" && r.field_id).map((r) => r.field_id as string))];
  const labels = new Map<string, string>();
  if (fieldIds.length > 0) {
    const { data: params, error: paramsError } = await supabase
      .from("field_recommendation_params")
      .select(`field_id, ${RECOMMENDATION_PARAMS_COLUMNS}`)
      .in("field_id", fieldIds);
    if (paramsError) return { rows: [], total: 0, error: paramsError.message };
    const byField = new Map(((params ?? []) as unknown as (RecommendationParamsRow & { field_id: string })[]).map((p) => [p.field_id, p]));
    for (const id of fieldIds) labels.set(id, standardAmountLabel(resolveRecommendationSettings(byField.get(id)).standardAmount));
  }
  const rows = sorted.map((r) => ({
    ...r,
    amount_label: r.kind === "fertilize_after_harvest" && r.field_id ? (labels.get(r.field_id) ?? null) : null,
  }));
  return { rows, total: count ?? rows.length, error: null };
}
