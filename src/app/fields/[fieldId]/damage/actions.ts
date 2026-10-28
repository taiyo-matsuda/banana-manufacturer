"use server";

import { refresh, revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  type BulkDamageInput,
  bulkMatDamageRows,
  checkFieldDamageEvent,
  type DamageErrors,
  type FieldDamageEvent,
  type TargetDamageInput,
  targetDamageEventRow,
  validateBulkDamage,
  validateTargetDamage,
} from "@/lib/damage";
import { findInvalidTargets } from "@/lib/fertilize";
import { recomputeDerivedQuietly } from "@/lib/derived";
import { occurredAtFromDate } from "@/lib/stemEvents";
import { createClient } from "@/lib/supabase/server";

// 圃場・株を対象にした被害（2-5、要件 4.3・UC-6）の Server Action。
// - オンライン前提（outbox に積まない。画面は圏外なら保存ボタンを無効にする）。茎の被害は 1-8 / 1-9 のまま
// - 入力はサーバーでも検証する（src/lib/damage.ts が正本）。「喪失（lost）」はここでも拒否する
// - organization_id は渡さない（トリガー set_org_from_target が圃場・株からコピーする。RLS で他組織の対象は見えない）
// - 画面は Server Action を関数として呼ぶ（<form action> にしない）。エラーで戻っても入力は state に残る（React 19 のフォームリセットを受けない）

const SAVE_FAILED = "保存できませんでした。時間をおいて再度お試しください";

export type RecordTargetDamageResult = { ok: true; eventId: string } | { ok: false; errors: DamageErrors };

// 圃場（target_type=field）か株（target_type=mat）に damage イベントを 1 件 insert する。
// event id は画面が確定ごとに採番する。同じ id が既にあれば（応答が届かず再送した場合）insert せず成功として返す
export async function recordTargetDamage(input: TargetDamageInput): Promise<RecordTargetDamageResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, errors: { form: "ログインが必要です。再度ログインしてください" } };

  const validation = validateTargetDamage(input);
  if (!validation.ok) return validation;
  const value = validation.value;

  const supabase = await createClient();
  const target =
    value.targetType === "field"
      ? supabase.from("fields").select("id").eq("id", value.targetId).maybeSingle()
      : supabase.from("mats").select("id, status").eq("id", value.targetId).maybeSingle();
  const [{ data: found, error: targetError }, { data: existing, error: existingError }] = await Promise.all([
    target,
    supabase.from("events").select("id").eq("id", value.eventId).maybeSingle(),
  ]);
  if (targetError || existingError) {
    console.error("damage select failed", { target: targetError?.message, existing: existingError?.message });
    return { ok: false, errors: { form: SAVE_FAILED } };
  }
  if (existing) return { ok: true, eventId: value.eventId };
  if (!found) {
    return { ok: false, errors: { form: value.targetType === "field" ? "圃場が見つかりません" : "株が見つかりません" } };
  }
  if (value.targetType === "mat" && (found as { status?: string }).status === "removed") {
    return { ok: false, errors: { form: "撤去した株には被害を記録できません" } };
  }

  const { error } = await supabase
    .from("events")
    .insert(targetDamageEventRow(value, occurredAtFromDate(value.date), user.id));
  if (error && error.code !== "23505") {
    console.error("damage insert failed", { code: error.code, message: error.message });
    return { ok: false, errors: { form: SAVE_FAILED } };
  }

  // 3-3: severe の圃場・株の被害は、その圃場・株の出蕾済みの茎の収穫予測を「要確認」にする（再計算して追記）
  if (value.severity === "severe") {
    await recomputeDerivedQuietly(
      supabase,
      value.targetType === "field" ? { fieldId: value.targetId } : { matId: value.targetId },
      "target damage",
    );
  }

  // 開いている画面（圃場・株の詳細の履歴）を取り直す
  refresh();
  return { ok: true, eventId: value.eventId };
}

export type RecordBulkDamageResult =
  | { ok: true; count: number }
  | { ok: false; errors: { targets?: string; form?: string } };

const INVALID_TARGETS_MESSAGE =
  "対象の株に、この圃場にない株か撤去した株が含まれています。画面を再読み込みしてやり直してください";

// 圃場の被害から、選んだ株に同じ内容（日付・種類・程度・メモ）の damage イベント（target_type=mat）を
// 配列 1 回で insert する（1 文 = 1 トランザクション。全件入るか、1 件も入らないか）。
// 内容は画面から受け取らず、圃場の被害イベントから取る（payload に field_event_id）。
// batch_id は画面が確定ごとに採番する。同じ batch_id が既にあれば insert せずに成功として返す（二重記録しない）
export async function recordBulkMatDamage(input: BulkDamageInput): Promise<RecordBulkDamageResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, errors: { form: "ログインが必要です。再度ログインしてください" } };

  const validation = validateBulkDamage(input);
  if (!validation.ok) return validation;
  const value = validation.value;

  const supabase = await createClient();
  const [
    { data: fieldEvent, error: eventError },
    { data: mats, error: matsError },
    { data: existing, error: existingError },
  ] = await Promise.all([
    supabase
      .from("events")
      .select("id, type, target_type, target_id, occurred_at, payload, note, superseded_by")
      .eq("id", value.fieldEventId)
      .maybeSingle(),
    supabase.from("mats").select("id").eq("field_id", value.fieldId).neq("status", "removed"),
    supabase
      .from("events")
      .select("id")
      .eq("type", "damage")
      .eq("target_type", "mat")
      .eq("payload->>batch_id", value.batchId)
      .limit(1),
  ]);
  if (eventError || matsError || existingError) {
    console.error("bulk damage select failed", {
      event: eventError?.message,
      mats: matsError?.message,
      existing: existingError?.message,
    });
    return { ok: false, errors: { form: SAVE_FAILED } };
  }

  const check = checkFieldDamageEvent(fieldEvent as FieldDamageEvent | null, value.fieldId);
  if (!check.ok) return { ok: false, errors: { form: check.error } };
  if ((existing ?? []).length > 0) return { ok: true, count: value.matIds.length };

  const allowed = new Set((mats ?? []).map((m) => m.id as string));
  if (findInvalidTargets(value.matIds, allowed).length > 0) {
    return { ok: false, errors: { targets: INVALID_TARGETS_MESSAGE } };
  }

  const { error } = await supabase
    .from("events")
    .insert(bulkMatDamageRows(fieldEvent as FieldDamageEvent, check, value.matIds, value.batchId, user.id));
  if (error) {
    console.error("bulk damage insert failed", { code: error.code, message: error.message });
    return { ok: false, errors: { form: SAVE_FAILED } };
  }

  // 3-3: severe なら、その株の出蕾済みの茎の収穫予測を再計算する（圃場の被害で既に要確認だが、inputs に株の被害も残す）
  if (check.severity === "severe") {
    await recomputeDerivedQuietly(supabase, { fieldId: value.fieldId }, "bulk mat damage");
  }

  // 株の詳細（株の記録）とこの画面の候補（記録済みの株を除く）を次に開いたとき取り直す
  revalidatePath("/", "layout");
  return { ok: true, count: value.matIds.length };
}
