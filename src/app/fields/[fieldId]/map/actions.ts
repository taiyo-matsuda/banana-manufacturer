"use server";

import { refresh } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { nextMatCodes } from "@/lib/mats/code";
import { type PlaceMatsInput, validatePlaceMatsInput } from "@/lib/mats/placement";

export type PlacedMat = { id: string; code: string; lat: number; lng: number };

export type PlaceMatsResult = { ok: true; mats: PlacedMat[] } | { ok: false; error: string };

// 格子で配置した株を mats に一括 insert する（1 回の insert に配列で渡す）。
// 株コードは `圃場記号-3桁連番`。連番はその圃場の既存の最大番号の次から（サーバー側で採番する）。
export async function placeMats(input: PlaceMatsInput): Promise<PlaceMatsResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "ログインが必要です" };

  const validation = validatePlaceMatsInput(input);
  if (!validation.ok) return validation;
  const { fieldId, cultivarId, plantedAt, originType, points } = validation.value;

  // RLS により自組織の圃場しか見えない
  const { data: field, error: fieldError } = await supabase
    .from("fields")
    .select("id, code")
    .eq("id", fieldId)
    .maybeSingle();
  if (fieldError || !field) return { ok: false, error: "圃場が見つかりません" };

  const { data: existing, error: existingError } = await supabase
    .from("mats")
    .select("code")
    .eq("field_id", fieldId);
  if (existingError) {
    console.error("mats select failed", { code: existingError.code, message: existingError.message });
    return { ok: false, error: "既存の株を取得できませんでした。時間をおいて再度お試しください" };
  }

  const codes = nextMatCodes(
    field.code,
    (existing ?? []).map((m) => m.code),
    points.length,
  );

  // organization_id は渡さない（INSERT トリガーが fields からコピーする）。status は既定の active
  const rows = points.map((p, i) => ({
    field_id: fieldId,
    code: codes[i],
    cultivar_id: cultivarId,
    lat: p.lat,
    lng: p.lng,
    planted_at: plantedAt,
    origin_type: originType,
  }));

  const { data: inserted, error } = await supabase
    .from("mats")
    .insert(rows)
    .select("id, code, lat, lng")
    .order("code");

  if (error) {
    console.error("mats insert failed", { code: error.code, message: error.message });
    if (error.code === "23505")
      return { ok: false, error: "株コードが重複しました。画面を再読み込みしてやり直してください" };
    return { ok: false, error: "株の保存に失敗しました。時間をおいて再度お試しください" };
  }

  refresh();
  return { ok: true, mats: inserted ?? [] };
}
