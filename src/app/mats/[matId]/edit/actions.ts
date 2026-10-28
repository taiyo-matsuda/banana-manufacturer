"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import { type MatEditInput, matUpdateErrorMessage, type UpdateMatState, validateMatEditInput } from "@/lib/mats/edit";
import { parseRemoveReason } from "@/lib/mats/remove";
import { recomputeRecommendationsQuietly } from "@/lib/derived";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 株の編集（/mats/[matId]/edit、UX-2）: 株コード・品種・植え付け日・苗の種類を更新する。
// field_id・organization_id・位置はフォームから受け取らない（更新対象にしない）。RLS の mats_all で自組織の行だけ更新できる。
// 株コードの圃場内の一意は DB の unique (field_id, code)（0001）が正本。重複は日本語のエラーにして拒否する。
// 株分け（sucker_transplant）の株は苗の種類を変えない（入力は無視する）。
// 植え付け日を変えても既存の茎の started_at / adopted_at は変えない（ずれは株の詳細に注意として出す）。
export async function updateMat(prev: UpdateMatState, formData: FormData): Promise<UpdateMatState> {
  const matId = String(formData.get("matId") ?? "");
  const values: MatEditInput = {
    code: String(formData.get("code") ?? ""),
    cultivarId: String(formData.get("cultivarId") ?? ""),
    plantedAt: String(formData.get("plantedAt") ?? ""),
    originType: String(formData.get("originType") ?? ""),
  };
  const fail = (error: string | null, errors: UpdateMatState["errors"] = {}): UpdateMatState => ({
    error,
    errors,
    values,
    succeeded: prev.succeeded,
  });

  const supabase = await createClient();
  const validId = UUID_PATTERN.test(matId);
  // 苗の種類を変えてよいかは、保存されている値で決める（フォームの値を信用しない）
  // PERF-1: ユーザーの確認と今の株の select を並べる（直列の往復 2 → 1。その後に update）。update はユーザー確認の後
  const [currentUser, currentResult] = await Promise.all([
    getCurrentUser(),
    validId ? supabase.from("mats").select("id, origin_type").eq("id", matId).maybeSingle() : null,
  ]);
  userOrRedirect(currentUser);

  if (!validId) return fail("株が見つかりません");
  const current = currentResult?.data;
  if (!current) return fail("株が見つかりません");

  const validation = validateMatEditInput(values, current.origin_type);
  if (!validation.ok) return fail(null, validation.errors);
  const { code, cultivarId, plantedAt, originType } = validation.value;

  const { data: updated, error } = await supabase
    .from("mats")
    .update({
      code,
      cultivar_id: cultivarId,
      planted_at: plantedAt,
      ...(originType ? { origin_type: originType } : {}),
    })
    .eq("id", matId)
    .select("id")
    .maybeSingle();

  if (error) {
    const message = matUpdateErrorMessage(error, code);
    if (!message) console.error("mats update failed", { code: error.code, message: error.message });
    return fail(message ?? "保存に失敗しました。時間をおいて再度お試しください");
  }
  if (!updated) return fail("株が見つかりません");

  // 株コードは株の詳細・地図の点（ラベル）・茎の画面のヘッダと「戻る」・履歴に出る。
  // revalidatePath を Server Action で呼ぶと、ルーターに残っている訪問済みの画面も次に開いたとき取り直す
  // （next/dist/docs の revalidatePath）。画面はどれもリクエストごとに描く（"use cache" なし）ので、ルート全体を対象にする。
  revalidatePath("/", "layout");
  return { error: null, errors: {}, values: { ...values, code }, succeeded: prev.succeeded + 1 };
}

export type RemoveMatResult = { ok: true } | { ok: false; error: string };

// 株の撤去（2-3、要確認 11）: RPC remove_mat（0012）が 1 トランザクションで mats.status=removed と
// mat_removed イベント（payload {reason}）を書く。栽培中の茎・未処理の吸芽があれば RPC が日本語の例外で拒否する
// （画面の事前判定は src/lib/mats/remove.ts の canRemoveMat。正本は DB）。
// イベントの id は画面が採番する（同じ確定を二重に送っても 1 回だけ）。オンライン前提（株の属性の変更は 1-9 の設計どおり）。
export async function removeMat(input: { eventId: string; matId: string; reason: string }): Promise<RemoveMatResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "ログインが必要です" };
  if (!UUID_PATTERN.test(input?.eventId ?? "") || !UUID_PATTERN.test(input?.matId ?? "")) {
    return { ok: false, error: "画面を再読み込みしてやり直してください" };
  }
  const reason = parseRemoveReason(input.reason);
  if (!reason.ok) return reason;

  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_mat", {
    p_event_id: input.eventId,
    p_mat_id: input.matId,
    p_occurred_at: new Date().toISOString(),
    p_reason: reason.value,
  });
  if (error) {
    if (error.code === "P0001") return { ok: false, error: error.message };
    console.error("remove_mat failed", { code: error.code, message: error.message });
    return { ok: false, error: "撤去を保存できませんでした。時間をおいて再度お試しください" };
  }
  // 3-5: 撤去した株の open の提案（収穫後の追肥）を「対象が終了」で閉じる（prediction.md 6 章）
  await recomputeRecommendationsQuietly(supabase, { matId: input.matId }, "remove mat");
  // 撤去した株は地図・株分けの地図から消え、株の詳細は「撤去済み」になる。訪問済みの画面も次に開いたとき取り直す
  revalidatePath("/", "layout");
  return { ok: true };
}
