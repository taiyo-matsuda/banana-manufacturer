import "server-only";

import type { ForecastStemInput } from "@/lib/forecast";
import { harvestDisplayFrom } from "@/lib/prediction/harvest";
import { createClient } from "@/lib/supabase/server";

// 予測一覧（3-6）の材料: 出蕾済み（status = flowered）の茎と、その最新の収穫予測日（latest_estimates、0021）。
// lost・収穫済みの茎は status で外れる（推定が残っていても読まない）。RLS（自組織だけ）は stems と security_invoker のビューで効く。
// fieldId を渡すとその圃場の株の茎に絞る（/forecast?field=）。
// 推定は茎の id で引く（ビューは茎 × 種類ごとの最新 1 行）。URL が長くなりすぎないよう id を分けて並べて引く
const ID_CHUNK = 150;

export async function fetchForecastStems(fieldId?: string): Promise<{ stems: ForecastStemInput[]; error: string | null }> {
  const supabase = await createClient();
  let query = supabase
    .from("stems")
    .select("id, generation, status, bud_emerged_at, mats!stems_mat_id_fkey!inner ( id, code, field_id, fields ( id, name ) )")
    .eq("status", "flowered");
  if (fieldId) query = query.eq("mats.field_id", fieldId);
  // PostgREST の既定の上限（max-rows）より多い場合に備えて明示する
  const { data: stems, error } = await query.limit(5000);
  if (error) return { stems: [], error: error.message };

  const ids = (stems ?? []).map((s) => s.id as string);
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) chunks.push(ids.slice(i, i + ID_CHUNK));
  const results = await Promise.all(
    chunks.map((chunk) =>
      supabase
        .from("latest_estimates")
        .select("stem_id, value_date, lower_date, upper_date, inputs, computed_at")
        .eq("kind", "harvest_date")
        .in("stem_id", chunk),
    ),
  );
  const estimateByStem = new Map<string, ReturnType<typeof harvestDisplayFrom>>();
  for (const r of results) {
    if (r.error) return { stems: [], error: r.error.message };
    for (const row of r.data ?? []) estimateByStem.set(row.stem_id as string, harvestDisplayFrom(row));
  }

  return {
    stems: (stems ?? []).map((s) => {
      const mat = s.mats as unknown as { id: string; code: string; field_id: string; fields: { id: string; name: string } | null };
      return {
        stemId: s.id as string,
        matId: mat.id,
        matCode: mat.code,
        fieldId: mat.field_id,
        fieldName: mat.fields?.name ?? "",
        generation: s.generation as number,
        status: s.status as string,
        budDate: (s.bud_emerged_at as string | null) ?? null,
        estimate: estimateByStem.get(s.id as string) ?? null,
      };
    }),
    error: null,
  };
}
