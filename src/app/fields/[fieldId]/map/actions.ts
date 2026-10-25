"use server";

import { refresh, revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";
import { nextMatCodes } from "@/lib/mats/code";
import { type PlaceMatsInput, validatePlaceMatsInput } from "@/lib/mats/placement";
import { type RelocateInput, validateRelocateInput } from "@/lib/mats/relocate";
import { newActiveStemRow } from "@/lib/stems/registration";

export type PlacedMat = { id: string; code: string; lat: number; lng: number };

export type PlaceMatsResult = { ok: true; mats: PlacedMat[] } | { ok: false; error: string };

// 格子で配置した株を mats に一括 insert する（1 回の insert に配列で渡す）。
// 株コードは `圃場記号-3桁連番`。連番はその圃場の既存の最大番号の次から（サーバー側で採番する）。
export async function placeMats(input: PlaceMatsInput): Promise<PlaceMatsResult> {
  const supabase = await createClient();
  // 入力の検証は DB を読まない純粋な関数なので先に済ませ、圃場・既存の株の select をユーザーの確認と並べる
  // （PERF-1: 直列の往復 3 → 1。その後に insert）。返す順（未ログイン → 入力 → 圃場 → 既存の株）は変えない。
  // insert はユーザー確認の後
  const validation = validatePlaceMatsInput(input);
  const fieldIdForRead = validation.ok ? validation.value.fieldId : null;
  const [user, reads] = await Promise.all([
    getCurrentUser(),
    fieldIdForRead
      ? Promise.all([
          // RLS により自組織の圃場しか見えない
          supabase.from("fields").select("id, code").eq("id", fieldIdForRead).maybeSingle(),
          supabase.from("mats").select("code").eq("field_id", fieldIdForRead),
        ])
      : null,
  ]);
  if (!user) return { ok: false, error: "ログインが必要です" };

  if (!validation.ok) return validation;
  if (!reads) return { ok: false, error: "圃場が見つかりません" };
  const { fieldId, cultivarId, plantedAt, originType, points, initialLeafCount } = validation.value;
  const [{ data: field, error: fieldError }, { data: existing, error: existingError }] = reads;

  if (fieldError || !field) return { ok: false, error: "圃場が見つかりません" };

  if (existingError) {
    console.error("mats select failed", { code: existingError.code, message: existingError.message });
    return { ok: false, error: "既存の株を取得できませんでした。時間をおいて再度お試しください" };
  }

  const codes = nextMatCodes(
    field.code,
    (existing ?? []).map((m) => m.code),
    points.length,
  );

  // organization_id は渡さない（INSERT トリガーが fields からコピーする）。status は既定の active
  const rows = points.map((p, i) => ({
    field_id: fieldId,
    code: codes[i],
    cultivar_id: cultivarId,
    lat: p.lat,
    lng: p.lng,
    planted_at: plantedAt,
    origin_type: originType,
  }));

  const { data: inserted, error } = await supabase
    .from("mats")
    .insert(rows)
    .select("id, code, lat, lng")
    .order("code");

  if (error) {
    console.error("mats insert failed", { code: error.code, message: error.message });
    if (error.code === "23505")
      return { ok: false, error: "株コードが重複しました。画面を再読み込みしてやり直してください" };
    return { ok: false, error: "株の保存に失敗しました。時間をおいて再度お試しください" };
  }
  const mats = inserted ?? [];

  // 初期葉数が入っていれば、株ごとに最初の茎（generation=1、active、started_at=adopted_at=植え付け日）も作る。
  // 要件 UC-1「一括で同じ値を入れ、例外だけ直す」。省略したら茎は作らず、後から株の詳細で登録できる。
  // 茎の insert に失敗したら株を残さない（作った株を消して失敗を返す。Supabase の REST にトランザクションはない）
  if (initialLeafCount !== null && mats.length > 0) {
    const stemRows = mats.map((m) =>
      newActiveStemRow(
        m.id,
        { plantedAt, initialLeafCount },
        { generation: 1, parentStemId: null },
      ),
    );
    const { error: stemsError } = await supabase.from("stems").insert(stemRows);
    if (stemsError) {
      console.error("stems insert failed", { code: stemsError.code, message: stemsError.message });
      const { error: rollbackError } = await supabase
        .from("mats")
        .delete()
        .in(
          "id",
          mats.map((m) => m.id),
        );
      if (rollbackError) {
        console.error("mats rollback failed", { code: rollbackError.code, message: rollbackError.message });
        refresh();
        return {
          ok: false,
          error: `株は保存されましたが茎を登録できませんでした（${mats[0]?.code}〜${mats.at(-1)?.code}）。株の詳細から茎を登録してください`,
        };
      }
      return { ok: false, error: "茎の登録に失敗したため、株も保存していません。時間をおいて再度お試しください" };
    }
  }

  refresh();
  return { ok: true, mats };
}

export type RelocateMatsResult = { ok: true; count: number } | { ok: false; error: string };

// 「位置を直す」モードの確定（2-3）: 動かした株だけの lat / lng を、RPC relocate_mats（0013）の 1 回でまとめて更新する。
// 位置は株の属性の修正なので events は作らない。オンライン前提（株の属性の変更は 1-9 の設計どおりオンラインのみ）。
// 撤去した株・別の圃場の株が含まれていたら（他の端末で撤去された等）どれも更新せず、理由を返す。
export async function relocateMats(input: RelocateInput): Promise<RelocateMatsResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "ログインが必要です" };
  const validation = validateRelocateInput(input);
  if (!validation.ok) return validation;
  const { fieldId, moves } = validation.value;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("relocate_mats", {
    p_field_id: fieldId,
    p_moves: moves.map((m) => ({ mat_id: m.matId, lat: m.lat, lng: m.lng })),
  });
  if (error) {
    // RPC の日本語の例外（P0001）はそのまま見せる
    if (error.code === "P0001") return { ok: false, error: error.message };
    console.error("relocate_mats failed", { code: error.code, message: error.message });
    return { ok: false, error: "位置を保存できませんでした。時間をおいて再度お試しください" };
  }
  // 株の位置は地図・株分けの地図に出る。訪問済みの画面も次に開いたとき取り直す
  revalidatePath("/", "layout");
  return { ok: true, count: (data as number | null) ?? moves.length };
}
