import { sortRecommendations, type OpenRecommendationRow } from "@/lib/recommendations/display";
import { createClient } from "@/lib/supabase/server";

// open の提案（3-4）をビュー open_recommendations から期限順に読む。ホーム（上位 limit 件）と /recommendations（全件）で共通。
// total は open の全件数（ホームの「すべて見る（N 件）」）
export async function fetchOpenRecommendations(
  limit?: number,
): Promise<{ rows: OpenRecommendationRow[]; total: number; error: string | null }> {
  const supabase = await createClient();
  let q = supabase
    .from("open_recommendations")
    .select("id, kind, target_type, target_id, due_at, reason, created_at, stem_id, generation, mat_id, mat_code, field_name", {
      count: "exact",
    })
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (limit !== undefined) q = q.limit(limit);
  const { data, error, count } = await q;
  if (error) return { rows: [], total: 0, error: error.message };
  const rows = sortRecommendations((data ?? []) as OpenRecommendationRow[]);
  return { rows, total: count ?? rows.length, error: null };
}
