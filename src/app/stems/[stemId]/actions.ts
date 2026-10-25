"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isCorrectableEventType, isCorrectableObservationType } from "@/lib/corrections";
import { createClient } from "@/lib/supabase/server";

// 記録の訂正（2-6）。RPC（0014_corrections.sql の correct_observation / correct_stem_event）が
// 1 トランザクションで「新しい行の追加」と「元の行の superseded_by」を書く（茎のイベントは茎の日付列も直す）。
// - オンライン前提（outbox に積まない）。画面は圏外なら訂正ボタンを無効にする
// - newId は画面がダイアログを開いたときに 1 つ採番する。同じ id の行があれば RPC は何もしない（応答が届かなかった再送）
// - 入力の検査は画面（src/lib/corrections.ts）と RPC が行う。RPC の日本語の例外（P0001）はそのまま見せる
// - organization_id は渡さない（INSERT トリガーがコピーする）

export type CorrectionResult = { ok: true } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RELOAD = "画面を再読み込みしてやり直してください";
const FAILED = "訂正を保存できませんでした。時間をおいて再度お試しください";

function validIso(s: unknown): s is string {
  return typeof s === "string" && !Number.isNaN(new Date(s).getTime());
}

export type CorrectObservationInput = {
  newId: string;
  oldId: string;
  type: string;
  value: number;
  observedAt: string;
};

export async function correctObservation(input: CorrectObservationInput): Promise<CorrectionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "ログインが必要です。再度ログインしてください" };
  if (!UUID.test(input.newId) || !UUID.test(input.oldId) || !isCorrectableObservationType(input.type)) {
    return { ok: false, error: RELOAD };
  }
  if (typeof input.value !== "number" || !Number.isFinite(input.value) || !validIso(input.observedAt)) {
    return { ok: false, error: "値と日付を確かめてください" };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("correct_observation", {
    p_new_id: input.newId,
    p_old_id: input.oldId,
    p_value: input.value,
    p_observed_at: input.observedAt,
  });
  if (error) {
    if (error.code === "P0001") return { ok: false, error: error.message };
    console.error("correct_observation failed", { code: error.code, message: error.message });
    return { ok: false, error: FAILED };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export type CorrectStemEventInput = {
  newId: string;
  oldId: string;
  type: string;
  occurredAt: string;
  payload: Record<string, unknown>;
};

export async function correctStemEvent(input: CorrectStemEventInput): Promise<CorrectionResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "ログインが必要です。再度ログインしてください" };
  if (!UUID.test(input.newId) || !UUID.test(input.oldId) || !isCorrectableEventType(input.type)) {
    return { ok: false, error: RELOAD };
  }
  if (!validIso(input.occurredAt) || typeof input.payload !== "object" || input.payload === null) {
    return { ok: false, error: "日付を確かめてください" };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("correct_stem_event", {
    p_new_id: input.newId,
    p_old_id: input.oldId,
    p_occurred_at: input.occurredAt,
    p_payload: input.payload,
  });
  if (error) {
    if (error.code === "P0001") return { ok: false, error: error.message };
    console.error("correct_stem_event failed", { code: error.code, message: error.message });
    return { ok: false, error: FAILED };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}
