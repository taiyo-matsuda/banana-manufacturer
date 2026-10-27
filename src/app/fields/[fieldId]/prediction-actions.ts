"use server";

import { refresh } from "next/cache";
import { requireUser } from "@/lib/auth/current-user";
import { type PredictionParamsState, validatePredictionParams } from "@/lib/fields/prediction-params";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 圃場の詳細の「予測の設定」（3-2）: 圃場 × 品種の基準温度・目標積算温度の上書きを field_cultivar_params に upsert する。
// 空欄は null（品種の既定を使う）。organization_id は渡さない（INSERT トリガーが圃場からコピーする）。
// 他組織の圃場は RLS（fcp_all の with check）で書けない（エラー → 「圃場が見つかりません」）。
export async function savePredictionParams(prev: PredictionParamsState, formData: FormData): Promise<PredictionParamsState> {
  const fieldId = String(formData.get("fieldId") ?? "");
  const cultivarId = String(formData.get("cultivarId") ?? "");
  const values = {
    baseTemp: String(formData.get("baseTemp") ?? ""),
    targetGdd: String(formData.get("targetGdd") ?? ""),
  };
  const fail = (error: string | null, errors: PredictionParamsState["errors"] = {}): PredictionParamsState => ({
    error,
    errors,
    values,
    saved: prev.saved,
    attempts: prev.attempts + 1,
    message: null,
  });

  const supabase = await createClient();
  await requireUser();
  if (!UUID_PATTERN.test(fieldId) || !UUID_PATTERN.test(cultivarId)) return fail("圃場が見つかりません");

  const validation = validatePredictionParams(values);
  if (!validation.ok) return fail(null, validation.errors);

  const { baseTempC, floweringToHarvestGdd } = validation.value;
  const { data, error } = await supabase
    .from("field_cultivar_params")
    .upsert(
      { field_id: fieldId, cultivar_id: cultivarId, base_temp_c: baseTempC, flowering_to_harvest_gdd: floweringToHarvestGdd },
      { onConflict: "field_id,cultivar_id" },
    )
    .select("field_id")
    .maybeSingle();
  if (error || !data) {
    // RLS（他組織・存在しない圃場）は 42501 / not null（23502）。それ以外はログに残す
    if (error && error.code !== "42501" && error.code !== "23502") {
      console.error("field_cultivar_params upsert failed", { code: error.code, message: error.message });
      return fail("保存に失敗しました。時間をおいて再度お試しください");
    }
    return fail("圃場が見つかりません");
  }

  refresh();
  return { error: null, errors: {}, values, saved: prev.saved + 1, attempts: prev.attempts + 1, message: "保存しました" };
}
