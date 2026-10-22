// 圃場の登録フォームの検証。UI に依存しない純粋関数。
// Server Action から呼び、理由（日本語）を画面に出す。

export type FieldInput = {
  name: string;
  code: string;
  lat: string;
  lng: string;
};

export type FieldErrors = Partial<Record<keyof FieldInput, string>>;

export const EMPTY_FIELD_INPUT: FieldInput = { name: "", code: "", lat: "", lng: "" };

// 登録 Server Action の戻り値（useActionState の state）
export type CreateFieldState = {
  // 全体のエラー（DB の重複など）
  error: string | null;
  // 項目ごとのエラー
  errors: FieldErrors;
  // 失敗時にフォームへ戻す値
  values: FieldInput;
  // 成功した回数。フォームのリセットに使う
  succeeded: number;
};

export type ValidFieldInput = {
  name: string;
  code: string;
  centerLat: number;
  centerLng: number;
};

export type FieldValidation =
  | { ok: true; value: ValidFieldInput }
  | { ok: false; errors: FieldErrors };

// 圃場記号は英数字 1〜4 文字（大文字に正規化する）
export const FIELD_CODE_PATTERN = /^[A-Za-z0-9]{1,4}$/;

export function validateFieldInput(input: FieldInput): FieldValidation {
  const errors: FieldErrors = {};

  const name = input.name.trim();
  if (!name) errors.name = "圃場の名前を入力してください";

  const code = input.code.trim().toUpperCase();
  if (!code) errors.code = "圃場記号を入力してください";
  else if (!FIELD_CODE_PATTERN.test(code))
    errors.code = "圃場記号は英数字 1〜4 文字で入力してください";

  const lat = parseCoordinate(input.lat);
  const lng = parseCoordinate(input.lng);
  if (lat === null) errors.lat = "代表点の緯度を入力してください";
  else if (lat < -90 || lat > 90) errors.lat = "緯度は -90〜90 の範囲で入力してください";
  if (lng === null) errors.lng = "代表点の経度を入力してください";
  else if (lng < -180 || lng > 180)
    errors.lng = "経度は -180〜180 の範囲で入力してください";

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { name, code, centerLat: lat as number, centerLng: lng as number },
  };
}

// 10 進小数（例: 26.5, -127.9, .5）だけを許す。"0x10" や "1e2" は Number() だと通ってしまうので使わない
const DECIMAL_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)$/;

// 空文字・10 進小数でない文字列は null（未指定扱い）
function parseCoordinate(s: string): number | null {
  const t = s.trim();
  if (!DECIMAL_PATTERN.test(t)) return null;
  return Number(t);
}

// PostgreSQL の unique 違反（23505）を、どの制約かで日本語のメッセージに変える
export function uniqueViolationMessage(error: {
  code?: string;
  message?: string;
}): string | null {
  if (error.code !== "23505") return null;
  const m = error.message ?? "";
  if (m.includes("fields_organization_id_code_key"))
    return "同じ圃場記号の圃場がすでにあります";
  if (m.includes("fields_organization_id_name_key"))
    return "同じ名前の圃場がすでにあります";
  return "同じ名前または圃場記号の圃場がすでにあります";
}
