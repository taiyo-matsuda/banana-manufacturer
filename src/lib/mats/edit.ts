// 株の編集（/mats/[matId]/edit、UX-2）の入力検証と、株の詳細の注意の判定。UI・DB に依存しない純粋関数。
// 編集できるのは株コード・品種・植え付け日・苗の種類。位置・圃場・organization_id は対象にしない
// （位置の修正はステップ 2。field_id / organization_id はフォームから受け取らない）。
import { isValidDateString, MAT_ORIGIN_TYPES, type MatOriginType } from "./placement";

export type MatEditInput = {
  code: string;
  cultivarId: string;
  plantedAt: string; // YYYY-MM-DD
  originType: string;
};

export type MatEditErrors = Partial<Record<keyof MatEditInput, string>>;

// 編集 Server Action の戻り値（useActionState の state）
export type UpdateMatState = {
  error: string | null;
  errors: MatEditErrors;
  // 失敗時にフォームへ戻す値
  values: MatEditInput;
  succeeded: number;
};

export type ValidMatEdit = {
  code: string;
  cultivarId: string;
  plantedAt: string;
  // null = 苗の種類は変えない（株分けで作った株）
  originType: MatOriginType | null;
};

export type MatEditValidation = { ok: true; value: ValidMatEdit } | { ok: false; errors: MatEditErrors };

export const MAT_CODE_MAX = 20;

// 株分け（sucker_transplant）で作った株は、由来の茎（origin_stem_id）と結び付いているので苗の種類を変えられない
export const SUCKER_TRANSPLANT_ORIGIN_LOCKED_REASON =
  "株分けで作った株は、苗の種類を変えられません（由来の茎と結び付いているため）";

export function isOriginTypeEditable(currentOriginType: string): boolean {
  return currentOriginType !== "sucker_transplant";
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMatOriginType(s: string): s is MatOriginType {
  return (MAT_ORIGIN_TYPES as readonly string[]).includes(s);
}

// 株コード: 前後の空白は取り除いて保存する（拒否はしない）。取り除いた結果が空なら不可。
// 圃場内の一意は DB の unique (field_id, code) が正本（重複は matUniqueViolationMessage で日本語にする）
export function normalizeMatCode(s: string): string {
  return s.trim();
}

// currentOriginType: いま保存されている苗の種類（株分けの株なら入力の originType は無視する）
export function validateMatEditInput(input: MatEditInput, currentOriginType: string): MatEditValidation {
  const errors: MatEditErrors = {};

  const code = normalizeMatCode(input.code);
  if (!code) errors.code = "株コードを入力してください";
  else if (code.length > MAT_CODE_MAX) errors.code = `株コードは ${MAT_CODE_MAX} 文字以内で入力してください`;

  if (!UUID_PATTERN.test(input.cultivarId)) errors.cultivarId = "品種を選んでください";

  if (!isValidDateString(input.plantedAt)) errors.plantedAt = "植え付け日を入力してください";

  let originType: MatOriginType | null = null;
  if (isOriginTypeEditable(currentOriginType)) {
    if (isMatOriginType(input.originType)) originType = input.originType;
    else errors.originType = "苗の種類を選んでください";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { code, cultivarId: input.cultivarId, plantedAt: input.plantedAt, originType } };
}

// 株コードの重複（unique (field_id, code)、0001）などの DB エラーを日本語にする。該当しなければ null
export function matUpdateErrorMessage(error: { code?: string; message?: string }, code: string): string | null {
  if (error.code === "23505") return `この圃場には株コード「${code}」の株がすでにあります`;
  if (error.code === "23503") return "選んだ品種が見つかりません。画面を再読み込みしてください";
  return null;
}

// 株の植え付け日と最初の茎（generation 1）の植え付け日（started_at）が違うか。
// 株の植え付け日を変えても茎の日付は直さない（UX-2）ので、ずれたら株の詳細に注意を出す
export function firstStemPlantedAtDiffers(
  matPlantedAt: string,
  stems: readonly { generation: number; started_at: string }[],
): boolean {
  return stems.some((s) => s.generation === 1 && s.started_at !== matPlantedAt);
}

export const FIRST_STEM_PLANTED_AT_DIFFERS_MESSAGE = "株の植え付け日と最初の茎の植え付け日が異なります";
