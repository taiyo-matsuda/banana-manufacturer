"use server";

import { refresh } from "next/cache";
import { requireUser } from "@/lib/auth/current-user";
import { recomputeDerivedQuietly } from "@/lib/derived";
import { type RecommendationParamsState, validateRecommendationParams } from "@/lib/recommendations/settings";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 圃場の詳細の「提案の設定」（3-4）: 袋掛け・摘蕾の日数 N と収穫期の日数を field_recommendation_params に upsert し、
// この圃場の提案を評価し直す（N を短くすると、その日数に達した茎に提案が出る。すでに出ている提案は閉じない）。
// 空欄は null（既定値）。organization_id は渡さない（INSERT トリガーが圃場からコピーする）。他組織の圃場は RLS で書けない。
export async function saveRecommendationParams(prev: RecommendationParamsState, formData: FormData): Promise<RecommendationParamsState> {
  const fieldId = String(formData.get("fieldId") ?? "");
  const values = {
    bagAfterDays: String(formData.get("bagAfterDays") ?? ""),
    harvestWindowDays: String(formData.get("harvestWindowDays") ?? ""),
  };
  const fail = (error: string | null, errors: RecommendationParamsState["errors"] = {}): RecommendationParamsState => ({
    error,
    errors,
    values,
    saved: prev.saved,
    attempts: prev.attempts + 1,
    message: null,
  });

  const supabase = await createClient();
  await requireUser();
  if (!UUID_PATTERN.test(fieldId)) return fail("圃場が見つかりません");

  const validation = validateRecommendationParams(values);
  if (!validation.ok) return fail(null, validation.errors);

  const { data, error } = await supabase
    .from("field_recommendation_params")
    .upsert(
      { field_id: fieldId, bag_after_days: validation.value.bagAfterDays, harvest_window_days: validation.value.harvestWindowDays },
      { onConflict: "field_id" },
    )
    .select("field_id")
    .maybeSingle();
  if (error || !data) {
    // RLS（他組織・存在しない圃場）は 42501 / not null（23502）/ FK（23503）。それ以外はログに残す
    if (error && error.code !== "42501" && error.code !== "23502" && error.code !== "23503") {
      console.error("field_recommendation_params upsert failed", { code: error.code, message: error.message });
      return fail("保存に失敗しました。時間をおいて再度お試しください");
    }
    return fail("圃場が見つかりません");
  }

  await recomputeDerivedQuietly(supabase, { fieldId }, "recommendation params");

  refresh();
  return { error: null, errors: {}, values, saved: prev.saved + 1, attempts: prev.attempts + 1, message: "保存しました" };
}
