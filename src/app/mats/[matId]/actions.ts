"use server";

import { refresh } from "next/cache";
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import {
  canAddActiveStem,
  isMaxActiveStemsError,
  newActiveStemRow,
  nextGeneration,
  type RegisterStemState,
  type StemInput,
  validateStemInput,
} from "@/lib/stems/registration";
import { createClient } from "@/lib/supabase/server";

// 株の詳細「茎を登録」: 植え付け日と初期葉数で stems に 1 行 insert する。
// 茎がなければ親（generation=1）。既に茎があれば `generation = 最大 + 1`、parent_stem_id = 直前の世代の茎。
// （2 本目以降は本来は吸芽の採用で作る。ステップ 2 で置き換える予定。1-5 では完了条件 2 の検証用）
// 最大 3 本の正本は DB トリガー stems_max_active。ここでは登録前に数えて断り、トリガーのエラーも日本語で返す。
export async function registerStem(
  prev: RegisterStemState,
  formData: FormData,
): Promise<RegisterStemState> {
  const matId = String(formData.get("matId") ?? "");
  const values: StemInput = {
    plantedAt: String(formData.get("plantedAt") ?? ""),
    initialLeafCount: String(formData.get("initialLeafCount") ?? ""),
  };
  const fail = (error: string | null, errors: RegisterStemState["errors"] = {}): RegisterStemState => ({
    error,
    errors,
    values,
    succeeded: prev.succeeded,
  });

  const supabase = await createClient();
  // PERF-1: ユーザーの確認と、株・茎の読み取り（matId だけで引ける）を並べる（直列の往復 3 → 1。その後に insert）。
  // 判定の順（未ログイン → 入力の検証 → 株がない → 茎を取れない）は変えない。insert はユーザー確認の後
  // RLS により他組織の株は見えない（茎も 0 件）
  const [currentUser, { data: mat }, { data: stems, error: stemsError }] = await Promise.all([
    getCurrentUser(),
    supabase.from("mats").select("id").eq("id", matId).maybeSingle(),
    supabase.from("stems").select("id, generation, status, started_at").eq("mat_id", matId),
  ]);
  userOrRedirect(currentUser);

  const validation = validateStemInput(values);
  if (!validation.ok) return fail(null, validation.errors);

  if (!mat) return fail("株が見つかりません");

  if (stemsError) {
    console.error("stems select failed", { code: stemsError.code, message: stemsError.message });
    return fail("茎を取得できませんでした。時間をおいて再度お試しください");
  }

  const check = canAddActiveStem(stems ?? []);
  if (!check.ok) return fail(check.reason);

  const { error } = await supabase
    .from("stems")
    .insert(newActiveStemRow(mat.id, validation.value, nextGeneration(stems ?? [])));
  if (error) {
    if (isMaxActiveStemsError(error)) return fail(MAX_ACTIVE_FROM_DB);
    console.error("stems insert failed", { code: error.code, message: error.message });
    return fail("茎の登録に失敗しました。時間をおいて再度お試しください");
  }

  refresh();
  return { error: null, errors: {}, values: { ...values, initialLeafCount: "" }, succeeded: prev.succeeded + 1 };
}

// トリガーで拒否されたとき（画面を開いた後に別の経路で 3 本になった場合など）
const MAX_ACTIVE_FROM_DB =
  "この株には既に栽培中の茎が 3 本あるため登録できませんでした（画面を再読み込みしてください）";
