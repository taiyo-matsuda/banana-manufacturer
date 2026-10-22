"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  type CreateFieldState,
  EMPTY_FIELD_INPUT,
  type FieldInput,
  uniqueViolationMessage,
  validateFieldInput,
} from "@/lib/fields/validation";

// "use server" のファイルは async 関数しか export できないので、型や定数は lib に置く

export async function createField(
  prev: CreateFieldState,
  formData: FormData,
): Promise<CreateFieldState> {
  const values: FieldInput = {
    name: String(formData.get("name") ?? ""),
    code: String(formData.get("code") ?? ""),
    lat: String(formData.get("lat") ?? ""),
    lng: String(formData.get("lng") ?? ""),
  };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const validation = validateFieldInput(values);
  if (!validation.ok) {
    return { error: null, errors: validation.errors, values, succeeded: prev.succeeded };
  }

  const { name, code, centerLat, centerLng } = validation.value;
  // organization_id は渡さない。fields は列の既定値 current_org() で DB が設定する（0004）
  const { error } = await supabase
    .from("fields")
    .insert({ name, code, center_lat: centerLat, center_lng: centerLng });

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

  // 一覧を最新にする（一覧はキャッシュしていないので refresh でよい）
  refresh();
  return { error: null, errors: {}, values: EMPTY_FIELD_INPUT, succeeded: prev.succeeded + 1 };
}
