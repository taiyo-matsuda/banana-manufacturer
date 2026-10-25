"use server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { nextMatCodes } from "@/lib/mats/code";
import { isMatCodeConflictError, type TransplantInput, validateTransplantInput } from "@/lib/mats/transplant";
import { createClient } from "@/lib/supabase/server";

export type TransplantResult =
  | { ok: true; matId: string; code: string }
  // conflict: 株コードが他の記録と重なった。nextCode は採番し直したコード（画面はこれで再試行する）
  | { ok: false; error: string; conflict?: { nextCode: string } };

// 株分けの確定（2-2）。RPC transplant_sucker（0011）が 1 トランザクションで新しい株・その generation 1 の茎・
// 元の吸芽の状態（transplanted）・sucker_transplanted イベントを書く。
// - id（イベント・新しい株・新しい茎）は画面が採番して渡す（同じ確定を二重に送っても p_event_id で 1 回だけ）
// - 株コードは画面が採番したもの（1-3 / 1-4 と同じ規則）。衝突したら（unique 違反）採番し直したコードを返す
// - organization_id は渡さない（トリガーが親からコピーする）。転出先の圃場が自組織であることは RLS で守る
export async function transplantSucker(input: TransplantInput): Promise<TransplantResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "ログインが必要です" };
  const validation = validateTransplantInput(input);
  if (!validation.ok) return validation;
  const v = validation.value;

  const supabase = await createClient();
  const { error } = await supabase.rpc("transplant_sucker", {
    p_event_id: v.eventId,
    p_stem_id: v.stemId,
    p_occurred_at: new Date().toISOString(),
    p_to_field_id: v.toFieldId,
    p_lat: v.lat,
    p_lng: v.lng,
    p_code: v.code,
    p_initial_leaf_count: v.initialLeafCount,
    p_new_mat_id: v.newMatId,
    p_new_stem_id: v.newStemId,
  });

  if (error) {
    if (isMatCodeConflictError(error)) {
      const [{ data: field }, { data: mats }] = await Promise.all([
        supabase.from("fields").select("code").eq("id", v.toFieldId).maybeSingle(),
        supabase.from("mats").select("code").eq("field_id", v.toFieldId),
      ]);
      if (!field || !mats) {
        return { ok: false, error: `株コード ${v.code} は既に使われていました。画面を再読み込みしてやり直してください` };
      }
      const nextCode = nextMatCodes(
        field.code,
        mats.map((m) => m.code),
        1,
      )[0];
      return {
        ok: false,
        error: `株コード ${v.code} は他の記録で使われていました。新しいコード ${nextCode} で再試行してください`,
        conflict: { nextCode },
      };
    }
    // RPC の日本語の例外（P0001: 吸芽でない、圃場が見つからないなど）はそのまま見せる
    if (error.code === "P0001") return { ok: false, error: error.message };
    console.error("transplant_sucker failed", { code: error.code, message: error.message });
    return { ok: false, error: "株分けを保存できませんでした。時間をおいて再度お試しください" };
  }
  return { ok: true, matId: v.newMatId, code: v.code };
}
