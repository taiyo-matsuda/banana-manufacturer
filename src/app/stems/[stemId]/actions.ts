"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import {
  canRecordLeaves,
  parseLeavesCurrent,
  parseLeavesNew,
  parseLeavesRemoved,
  type RecordState,
} from "@/lib/stems/records";
import { createClient } from "@/lib/supabase/server";

// 茎の記録入力（1-6）。観測・イベントは追記のみ（更新・削除の Action は作らない）。
// organization_id は渡さない（INSERT トリガーが stems / target からコピーする）。
// 観測者・記録者はログイン中の profile id（profiles.id = auth.users.id）。

type Prepared =
  | { ok: true; userId: string; stemId: string }
  | { ok: false; error: string };

// ログインと、記録できる茎（自組織・栽培中）であることを確かめる
async function prepare(formData: FormData): Promise<Prepared> {
  const stemId = String(formData.get("stemId") ?? "");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS により他組織の茎は見えない
  const { data: stem, error } = await supabase.from("stems").select("id, status").eq("id", stemId).maybeSingle();
  if (error) {
    console.error("stems select failed", { code: error.code, message: error.message });
    return { ok: false, error: "茎を取得できませんでした。時間をおいて再度お試しください" };
  }
  if (!stem) return { ok: false, error: "茎が見つかりません" };
  if (!canRecordLeaves(stem.status)) {
    return { ok: false, error: "この茎は栽培中ではないため記録できません（画面を再読み込みしてください）" };
  }
  return { ok: true, userId: user.id, stemId: stem.id };
}

const fail = (prev: RecordState, error: string): RecordState => ({ error, succeeded: prev.succeeded });
const succeed = (prev: RecordState): RecordState => ({ error: null, succeeded: prev.succeeded + 1 });

async function insertObservation(
  prev: RecordState,
  formData: FormData,
  type: "leaves_new" | "leaves_current",
  value: number,
): Promise<RecordState> {
  const prepared = await prepare(formData);
  if (!prepared.ok) return fail(prev, prepared.error);
  const supabase = await createClient();
  const { error } = await supabase.from("observations").insert({
    stem_id: prepared.stemId,
    type,
    value,
    observed_at: new Date().toISOString(),
    observed_by: prepared.userId,
  });
  if (error) {
    console.error("observations insert failed", { code: error.code, message: error.message, type });
    return fail(prev, "記録に失敗しました。時間をおいて再度お試しください");
  }
  refresh();
  return succeed(prev);
}

// 「+0 / +1 / +2」ボタン（name=count）または数字入力（name=countInput）で新たに開いた葉の枚数を記録する。
// +0 も記録する（「見たが増えていない」も事実）
export async function recordLeavesNew(prev: RecordState, formData: FormData): Promise<RecordState> {
  const raw = formData.get("count") ?? formData.get("countInput");
  const parsed = parseLeavesNew(raw === null ? "" : String(raw));
  if (!parsed.ok) return fail(prev, parsed.error);
  return insertObservation(prev, formData, "leaves_new", parsed.value);
}

// 現在の葉数
export async function recordLeavesCurrent(prev: RecordState, formData: FormData): Promise<RecordState> {
  const parsed = parseLeavesCurrent(String(formData.get("count") ?? ""));
  if (!parsed.ok) return fail(prev, parsed.error);
  return insertObservation(prev, formData, "leaves_current", parsed.value);
}

// 枯葉処理（イベント）: events に type=leaves_removed, target=stem, payload={count}
export async function recordLeavesRemoved(prev: RecordState, formData: FormData): Promise<RecordState> {
  const parsed = parseLeavesRemoved(String(formData.get("count") ?? ""));
  if (!parsed.ok) return fail(prev, parsed.error);
  const prepared = await prepare(formData);
  if (!prepared.ok) return fail(prev, prepared.error);
  const supabase = await createClient();
  const { error } = await supabase.from("events").insert({
    type: "leaves_removed",
    target_type: "stem",
    target_id: prepared.stemId,
    occurred_at: new Date().toISOString(),
    recorded_by: prepared.userId,
    payload: { count: parsed.value },
  });
  if (error) {
    console.error("events insert failed", { code: error.code, message: error.message, type: "leaves_removed" });
    return fail(prev, "枯葉処理の記録に失敗しました。時間をおいて再度お試しください");
  }
  refresh();
  return succeed(prev);
}
