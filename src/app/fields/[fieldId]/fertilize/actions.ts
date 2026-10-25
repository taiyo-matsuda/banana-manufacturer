"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  type FertilizeSubmission,
  fertilizedEventRows,
  findInvalidTargets,
  type SubmissionErrors,
  sumAmounts,
  validateFertilizeSubmission,
} from "@/lib/fertilize";
import { occurredAtFromDate } from "@/lib/stemEvents";
import { createClient } from "@/lib/supabase/server";

export type RecordFertilizationResult =
  | { ok: true; count: number; total: number }
  | { ok: false; errors: SubmissionErrors };

const INVALID_TARGETS_MESSAGE =
  "対象の株に、この圃場にない株か撤去した株が含まれています。画面を再読み込みしてやり直してください";

// 施肥の一括入力（2-4、画面 5）の確定。株ごとの fertilized イベントを events に配列 1 回で insert する
// （PostgREST の配列 insert は 1 文 = 1 トランザクション。全件入るか、1 件も入らないか）。
// - オンライン前提（件数が多いので outbox に積まない。画面は圏外なら確定ボタンを無効にする）
// - 入力はサーバーでも検証する（src/lib/fertilize.ts の validateFertilizeSubmission が正本）
// - 対象の株は、その圃場の撤去していない株であること（RLS で他組織の株・圃場は見えない）
// - organization_id は渡さない（トリガー set_org_from_target が株からコピーする）
// - batch_id は画面が確認ダイアログを開くたびに 1 つ採番する。同じ batch_id が既にあれば（応答が届かず再送した場合）
//   insert せずに成功として返す（二重記録を防ぐ）
export async function recordFertilization(input: FertilizeSubmission): Promise<RecordFertilizationResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, errors: { form: "ログインが必要です。再度ログインしてください" } };

  const validation = validateFertilizeSubmission(input);
  if (!validation.ok) return validation;
  const value = validation.value;

  const supabase = await createClient();
  // 圃場の撤去していない株（id だけ）と、同じ batch_id の既存イベントを並べて読む。
  // 対象の株の id を in() で渡すと 400 株で URL が長くなるので、圃場の株を全部読んで照らす
  const [{ data: field }, { data: mats, error: matsError }, { data: existing, error: existingError }] = await Promise.all([
    supabase.from("fields").select("id").eq("id", value.fieldId).maybeSingle(),
    supabase.from("mats").select("id").eq("field_id", value.fieldId).neq("status", "removed"),
    supabase
      .from("events")
      .select("id")
      .eq("type", "fertilized")
      .eq("payload->>batch_id", value.batchId)
      .limit(1),
  ]);
  if (matsError || existingError) {
    console.error("fertilize select failed", { mats: matsError?.message, existing: existingError?.message });
    return { ok: false, errors: { form: "保存できませんでした。時間をおいて再度お試しください" } };
  }
  if (!field) return { ok: false, errors: { form: "圃場が見つかりません" } };

  const total = sumAmounts(value.items.map((i) => i.amount));
  if ((existing ?? []).length > 0) return { ok: true, count: value.items.length, total };

  const allowed = new Set((mats ?? []).map((m) => m.id as string));
  if (findInvalidTargets(value.items.map((i) => i.matId), allowed).length > 0) {
    return { ok: false, errors: { targets: INVALID_TARGETS_MESSAGE } };
  }

  const { error } = await supabase
    .from("events")
    .insert(fertilizedEventRows(value, occurredAtFromDate(value.date), user.id));
  if (error) {
    console.error("fertilized insert failed", { code: error.code, message: error.message });
    return { ok: false, errors: { form: "保存できませんでした。時間をおいて再度お試しください" } };
  }

  // 株の詳細（施肥の履歴）と、この画面の肥料名の候補・単位の既定値を次に開いたとき取り直す
  revalidatePath("/", "layout");
  return { ok: true, count: value.items.length, total };
}
