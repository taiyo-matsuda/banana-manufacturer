// 株分け（2-2、要件 3 章「吸芽の扱い」・UC-4）の入力検証と位置の判定。UI・DB に依存しない純粋関数。
//
// 株分けは RPC transplant_sucker（supabase/migrations/0011_sucker_actions.sql）が 1 トランザクションで
// 新しい株・その generation 1 の茎・元の吸芽の状態・イベントを書く。ここは画面と Server Action の事前判定。
// 状態の前提（吸芽の茎だけ）は stemEvents.ts の canDoSuckerAction。
import { distanceM, type LatLng } from "../geo";
import { parseRequiredInitialLeafCount } from "../stemEvents";

// 既存の株からこれより近い位置には株分けしない（同じ位置への重ね置きの誤タップ対策）
export const MIN_TRANSPLANT_DISTANCE_M = 1;

export type PositionCheck = { ok: true } | { ok: false; error: string };

// タップした位置が空いているか（既存の株のどれからも MIN_TRANSPLANT_DISTANCE_M 以上離れているか）
export function checkFreePosition(
  point: LatLng,
  mats: readonly (LatLng & { code: string })[],
  minDistanceM = MIN_TRANSPLANT_DISTANCE_M,
): PositionCheck {
  let nearest: { code: string; d: number } | null = null;
  for (const m of mats) {
    const d = distanceM(point, m);
    if (!nearest || d < nearest.d) nearest = { code: m.code, d };
  }
  if (nearest && nearest.d < minDistanceM) {
    return { ok: false, error: `株 ${nearest.code} に近すぎます。空いている位置をタップしてください` };
  }
  return { ok: true };
}

export type TransplantInput = {
  eventId: string;
  stemId: string;
  toFieldId: string;
  newMatId: string;
  newStemId: string;
  lat: number | null;
  lng: number | null;
  code: string;
  initialLeafCount: string;
};

export type ValidTransplantInput = Omit<TransplantInput, "lat" | "lng" | "initialLeafCount"> & {
  lat: number;
  lng: number;
  initialLeafCount: number;
};

export type TransplantValidation = { ok: true; value: ValidTransplantInput } | { ok: false; error: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAT_CODE_PATTERN = /^[0-9A-Za-z]{1,4}-\d{3,}$/;

export function validateTransplantInput(input: TransplantInput): TransplantValidation {
  for (const id of [input.eventId, input.stemId, input.newMatId, input.newStemId]) {
    if (!UUID_PATTERN.test(id ?? "")) return { ok: false, error: "画面を再読み込みしてやり直してください" };
  }
  if (!UUID_PATTERN.test(input.toFieldId ?? "")) return { ok: false, error: "転出先の圃場を選んでください" };
  const { lat, lng } = input;
  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return { ok: false, error: "転出先の位置を地図でタップしてください" };
  }
  const code = (input.code ?? "").trim();
  if (!MAT_CODE_PATTERN.test(code)) return { ok: false, error: "新しい株のコードを決められませんでした。画面を再読み込みしてください" };
  const leaves = parseRequiredInitialLeafCount(input.initialLeafCount);
  if (!leaves.ok) return leaves;
  return {
    ok: true,
    value: { ...input, code, lat, lng, initialLeafCount: leaves.value },
  };
}

// RPC transplant_sucker が株コードの衝突で返すエラーか（SQLSTATE 23505・hint 'mat_code_conflict'）
export function isMatCodeConflictError(error: { code?: string | null; hint?: string | null } | null | undefined): boolean {
  return error?.code === "23505" && error?.hint === "mat_code_conflict";
}
