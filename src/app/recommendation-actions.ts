"use server";

import { refresh } from "next/cache";
import { requireUser } from "@/lib/auth/current-user";
import { DISMISSED_NOTE } from "@/lib/recommendations/rules";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DismissResult = { ok: true } | { ok: false; error: string };

// ホームの「提案」の「無視」（3-4、prediction.md 6 章）: open の提案を dismissed にする（resolved_at はトリガーが now()、
// resolved_by はログイン中のユーザー）。行は消さない。dismissed は unique (target_type, target_id, kind, rule_key) で残るので、
// 同じ提案は再び作られない（0022）。他組織の提案・閉じ済みの提案は 0 行（「見つからない」）
export async function dismissRecommendation(id: string): Promise<DismissResult> {
  const user = await requireUser();
  if (!UUID_PATTERN.test(id)) return { ok: false, error: "提案が見つかりません" };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("recommendations")
    .update({ status: "dismissed", resolution_note: DISMISSED_NOTE, resolved_by: user.id })
    .eq("id", id)
    .eq("status", "open")
    .select("id");
  if (error) {
    console.error("recommendation dismiss failed", { code: error.code, message: error.message });
    return { ok: false, error: "保存に失敗しました。時間をおいて再度お試しください" };
  }
  if (!data || data.length === 0) return { ok: false, error: "この提案は見つからないか、すでに閉じています" };
  refresh();
  return { ok: true };
}
