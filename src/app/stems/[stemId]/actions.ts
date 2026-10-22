"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { parseLatLng, parsePhotoKind, parseTakenAtIso, photoStoragePath, type PhotoRecordState } from "@/lib/photos";
import {
  canRecordLeaves,
  parseLeavesCurrent,
  parseLeavesNew,
  parseLeavesRemoved,
  type RecordState,
  toLeafObservations,
} from "@/lib/stems/records";
import { cumulativeLeaves } from "@/lib/leaves";
import { stemStatusLabel } from "@/lib/stems/status";
import {
  canRecordEvent,
  type EventRecordState,
  occurredAtFromDate,
  parseEventInput,
  stemEventLabel,
} from "@/lib/stemEvents";
import { createClient } from "@/lib/supabase/server";

// 茎の記録入力（1-6）とイベント（1-8）。観測・イベントは追記のみ（更新・削除の Action は作らない）。
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

// --- 写真（1-7） ---------------------------------------------------------------
//
// 流れ: ① preparePhotoUpload で photo_id と Storage のパスを採番（organization_id はサーバーで profiles から取る）
//       → ② ブラウザが Storage に直接アップロード（ユーザーのセッション、RLS で自組織のフォルダだけ）
//       → ③ recordPhoto で photos に 1 行追記（パスはサーバーで組み直し、クライアントの値は信用しない）。
// 写真も追記のみ（更新・削除の Action は作らない）。

export type PreparedPhotoUpload =
  | { ok: true; photoId: string; storagePath: string }
  | { ok: false; error: string };

export async function preparePhotoUpload(stemId: string): Promise<PreparedPhotoUpload> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: profile, error: profileError }, { data: stem, error: stemError }] = await Promise.all([
    supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle(),
    supabase.from("stems").select("id").eq("id", stemId).maybeSingle(),
  ]);
  if (profileError || !profile) {
    console.error("profiles select failed", { code: profileError?.code, message: profileError?.message });
    return { ok: false, error: "組織を取得できませんでした。時間をおいて再度お試しください" };
  }
  if (stemError) {
    console.error("stems select failed", { code: stemError.code, message: stemError.message });
    return { ok: false, error: "茎を取得できませんでした。時間をおいて再度お試しください" };
  }
  if (!stem) return { ok: false, error: "茎が見つかりません" };

  const photoId = crypto.randomUUID();
  return {
    ok: true,
    photoId,
    storagePath: photoStoragePath({ organizationId: profile.organization_id, targetType: "stem", targetId: stem.id, photoId }),
  };
}

export type RecordPhotoInput = {
  stemId: string;
  photoId: string;
  takenAt: string; // ISO
  kind: string;
  lat: string;
  lng: string;
};

// Storage へのアップロードが成功した後に呼ぶ。photos に target_type=stem の行を追記する。
// organization_id は渡さない（INSERT トリガーが target からコピーする）
export async function recordPhoto(prev: PhotoRecordState, input: RecordPhotoInput): Promise<PhotoRecordState> {
  const failed = (error: string): PhotoRecordState => ({ error, succeeded: prev.succeeded });
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  if (!UUID_PATTERN.test(input.photoId)) return failed("写真の id が不正です");
  const takenAt = parseTakenAtIso(input.takenAt);
  if (!takenAt) return failed("撮影日時が不正です");
  const kind = parsePhotoKind(input.kind);
  const latLng = parseLatLng(input.lat, input.lng);

  const [{ data: profile, error: profileError }, { data: stem, error: stemError }] = await Promise.all([
    supabase.from("profiles").select("organization_id").eq("id", user.id).maybeSingle(),
    supabase.from("stems").select("id").eq("id", input.stemId).maybeSingle(),
  ]);
  if (profileError || !profile) return failed("組織を取得できませんでした。時間をおいて再度お試しください");
  if (stemError) return failed("茎を取得できませんでした。時間をおいて再度お試しください");
  if (!stem) return failed("茎が見つかりません");

  const storagePath = photoStoragePath({
    organizationId: profile.organization_id,
    targetType: "stem",
    targetId: stem.id,
    photoId: input.photoId,
  });
  const { error } = await supabase.from("photos").insert({
    id: input.photoId,
    storage_path: storagePath,
    taken_at: takenAt.toISOString(),
    taken_by: user.id,
    lat: latLng?.lat ?? null,
    lng: latLng?.lng ?? null,
    target_type: "stem",
    target_id: stem.id,
    kind,
    upload_status: "uploaded",
  });
  if (error) {
    console.error("photos insert failed", { code: error.code, message: error.message });
    return failed("写真の記録に失敗しました。時間をおいて再度お試しください");
  }
  refresh();
  return { error: null, succeeded: prev.succeeded + 1 };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// --- イベント（1-8） -----------------------------------------------------------
//
// 出蕾・段数・袋掛け・摘蕾・収穫・被害を DB の RPC `record_stem_event`（0008）で記録する。
// RPC が events への追記と stems の状態・日付列の更新を同一トランザクションで行い、状態の前提
// （出蕾は active のみ、袋掛け〜収穫は flowered のみ、被害は active / flowered）を正本として検査する。
// アプリ側は stemEvents.ts の同じ表で事前に断り、RPC の例外メッセージ（日本語）はそのまま画面に出す。
// 出蕾は Server Action がその時点の累計葉数（leaves.ts）を計算して payload.cumulative_leaves に入れ、
// 生葉数・偽茎周囲長を observations にも追記する。

export async function recordStemEvent(prev: EventRecordState, formData: FormData): Promise<EventRecordState> {
  const failed = (error: string): EventRecordState => ({ error, succeeded: prev.succeeded, lastType: prev.lastType });
  const text = (name: string) => {
    const v = formData.get(name);
    return v === null ? undefined : String(v);
  };

  const parsed = parseEventInput({
    type: text("type") ?? "",
    date: text("date") ?? "",
    earliestAt: text("earliestAt"),
    leavesCurrent: text("leavesCurrent"),
    girthCm: text("girthCm"),
    hands: text("hands"),
    weightKg: text("weightKg"),
    kind: text("kind"),
    severity: text("severity"),
  });
  if (!parsed.ok) return failed(parsed.error);
  const { type, date, payload } = parsed.value;

  const stemId = String(formData.get("stemId") ?? "");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS により他組織の茎は見えない
  const { data: stem, error: stemError } = await supabase
    .from("stems")
    .select("id, status, initial_leaf_count")
    .eq("id", stemId)
    .maybeSingle();
  if (stemError) {
    console.error("stems select failed", { code: stemError.code, message: stemError.message });
    return failed("茎を取得できませんでした。時間をおいて再度お試しください");
  }
  if (!stem) return failed("茎が見つかりません");
  if (!canRecordEvent(stem.status, type)) {
    return failed(`${stemEventLabel(type)}はこの茎（${stemStatusLabel(stem.status)}）には記録できません（画面を再読み込みしてください）`);
  }

  const occurredAt = occurredAtFromDate(date);

  // 出蕾: その時点の累計葉数（初期葉数 + Σ leaves_new。現在の値 = superseded_by が null）を payload に入れる
  if (type === "bud_emerged") {
    const { data: observations, error: obsError } = await supabase
      .from("observations")
      .select("id, type, value, observed_at, superseded_by")
      .eq("stem_id", stem.id)
      .eq("type", "leaves_new");
    if (obsError) {
      console.error("observations select failed", { code: obsError.code, message: obsError.message });
      return failed("観測を取得できませんでした。時間をおいて再度お試しください");
    }
    payload.cumulative_leaves = cumulativeLeaves(stem.initial_leaf_count ?? 0, toLeafObservations(observations ?? []));
  }

  const { error: rpcError } = await supabase.rpc("record_stem_event", {
    p_stem_id: stem.id,
    p_type: type,
    p_occurred_at: occurredAt,
    p_payload: payload,
    p_note: null,
  });
  if (rpcError) {
    console.error("record_stem_event failed", { code: rpcError.code, message: rpcError.message, type });
    return failed(rpcError.message || `${stemEventLabel(type)}の記録に失敗しました。時間をおいて再度お試しください`);
  }

  // 出蕾: 生葉数・偽茎周囲長は観測としても残す（検算・果房重量の推定に使う）。observed_at は確認日
  if (type === "bud_emerged") {
    const { error: insertError } = await supabase.from("observations").insert([
      { stem_id: stem.id, type: "leaves_current", value: payload.leaves_current as number, observed_at: occurredAt, observed_by: user.id },
      { stem_id: stem.id, type: "pseudostem_girth_cm", value: payload.girth_cm as number, observed_at: occurredAt, observed_by: user.id },
    ]);
    if (insertError) {
      console.error("observations insert failed", { code: insertError.code, message: insertError.message });
      refresh();
      return failed("出蕾は記録しましたが、生葉数・周囲長の観測を保存できませんでした。「現在の葉数」から入れ直してください");
    }
  }

  refresh();
  return { error: null, succeeded: prev.succeeded + 1, lastType: type };
}
