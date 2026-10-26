"use server";

import { refresh, revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireUser } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";
import {
  type CreateFieldState,
  EMPTY_FIELD_INPUT,
  type FieldInput,
  uniqueViolationMessage,
  validateFieldInput,
} from "@/lib/fields/validation";
import { syncWeatherInBackground } from "@/lib/weather/user-sync";

// "use server" のファイルは async 関数しか export できないので、型や定数は lib に置く

function readFieldInput(formData: FormData): FieldInput {
  return {
    name: String(formData.get("name") ?? ""),
    code: String(formData.get("code") ?? ""),
    lat: String(formData.get("lat") ?? ""),
    lng: String(formData.get("lng") ?? ""),
    notes: String(formData.get("notes") ?? ""),
  };
}

export async function createField(
  prev: CreateFieldState,
  formData: FormData,
): Promise<CreateFieldState> {
  const values = readFieldInput(formData);

  const supabase = await createClient();
  // 書き込みの前にユーザーを確かめる（insert / update はユーザー確認の後。直列のまま）
  await requireUser();

  const validation = validateFieldInput(values);
  if (!validation.ok) {
    return { error: null, errors: validation.errors, values, succeeded: prev.succeeded };
  }

  const { name, code, centerLat, centerLng, notes } = validation.value;
  // organization_id は渡さない。fields は列の既定値 current_org() で DB が設定する（0004）
  const { data: created, error } = await supabase
    .from("fields")
    .insert({ name, code, center_lat: centerLat, center_lng: centerLng, notes })
    .select("id")
    .single();

  if (error) {
    const message = uniqueViolationMessage(error);
    if (!message) {
      // 想定外の DB エラーはログに残し、画面には定型文を出す
      console.error("fields insert failed", { code: error.code, message: error.message });
    }
    return {
      error: message ?? "登録に失敗しました。時間をおいて再度お試しください",
      errors: {},
      values,
      succeeded: prev.succeeded,
    };
  }

  // 気温の取り込み（3-1）: 登録日（または最も古い茎）以降と直近の日を、応答を返した後に取る（登録の応答を遅くしない）。
  // 10 年分の平年値の材料は次回の日次の取り込み（Cron）か、圃場の詳細の「今すぐ取り込む」で取る
  after(() => syncWeatherInBackground(supabase, created.id));

  // 一覧を最新にする（一覧はキャッシュしていないので refresh でよい）
  refresh();
  return { error: null, errors: {}, values: EMPTY_FIELD_INPUT, succeeded: prev.succeeded + 1 };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 圃場の編集（/fields/[fieldId]/edit、UX-2）。検証は登録と同じ（validateFieldInput）。
// 更新するのは名前・記号・代表点・メモだけ（organization_id は受け取らない。RLS の fields_all で自組織の行だけ更新できる）。
// 圃場記号を変えても既存の株コードは変えない（新しく追加する株から新しい記号。採番は src/lib/mats/code.ts）。
export async function updateField(
  prev: CreateFieldState,
  formData: FormData,
): Promise<CreateFieldState> {
  const fieldId = String(formData.get("fieldId") ?? "");
  const values = readFieldInput(formData);
  const fail = (error: string | null, errors: CreateFieldState["errors"] = {}): CreateFieldState => ({
    error,
    errors,
    values,
    succeeded: prev.succeeded,
  });

  const supabase = await createClient();
  // 書き込みの前にユーザーを確かめる（insert / update はユーザー確認の後。直列のまま）
  await requireUser();

  if (!UUID_PATTERN.test(fieldId)) return fail("圃場が見つかりません");

  const validation = validateFieldInput(values);
  if (!validation.ok) return fail(null, validation.errors);

  const { name, code, centerLat, centerLng, notes } = validation.value;
  // 代表点が変わったかを見るため、更新前の代表点を読む（RLS で自組織の行だけ）
  const { data: before } = await supabase
    .from("fields")
    .select("center_lat, center_lng")
    .eq("id", fieldId)
    .maybeSingle();
  const { data: updated, error } = await supabase
    .from("fields")
    .update({ name, code, center_lat: centerLat, center_lng: centerLng, notes })
    .eq("id", fieldId)
    .select("id")
    .maybeSingle();

  if (error) {
    const message = uniqueViolationMessage(error);
    if (!message) console.error("fields update failed", { code: error.code, message: error.message });
    return fail(message ?? "保存に失敗しました。時間をおいて再度お試しください");
  }
  // RLS で見えない（他組織・削除済み）なら 0 行
  if (!updated) return fail("圃場が見つかりません");

  // 代表点が変わったら気温を取り直す（3-1。前の地点の値は取り込みの中で消す）。応答を返した後に走らせる
  if (before && (Number(before.center_lat) !== centerLat || Number(before.center_lng) !== centerLng)) {
    after(() => syncWeatherInBackground(supabase, fieldId));
  }

  // 圃場の名前・記号は一覧・詳細・地図のヘッダ・株の詳細（地図への導線）に出る。
  // revalidatePath を Server Action で呼ぶと、ルーターに残っている訪問済みの画面も次に開いたとき取り直す
  // （next/dist/docs の revalidatePath）。画面はどれもリクエストごとに描く（"use cache" なし）ので、
  // ルート全体（layout）を対象にして、どの画面にも古い名前が残らないようにする。
  revalidatePath("/", "layout");
  return { error: null, errors: {}, values, succeeded: prev.succeeded + 1 };
}
