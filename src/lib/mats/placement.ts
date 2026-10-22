// 株の一括配置（格子）の入力検証。Server Action から呼ぶ純粋関数。
import type { LatLng } from "@/lib/geo";

export const MAT_ORIGIN_TYPES = ["tissue_culture", "sucker_purchased"] as const;
export type MatOriginType = (typeof MAT_ORIGIN_TYPES)[number];

export const MAT_ORIGIN_LABELS: Record<MatOriginType, string> = {
  tissue_culture: "組織培養",
  sucker_purchased: "購入吸芽",
};

// 一度に配置できる株の上限（誤入力対策）
export const MAX_MATS_PER_PLACEMENT = 500;

export type PlaceMatsInput = {
  fieldId: string;
  cultivarId: string;
  plantedAt: string; // YYYY-MM-DD
  originType: string;
  points: LatLng[];
};

export type ValidPlaceMatsInput = {
  fieldId: string;
  cultivarId: string;
  plantedAt: string;
  originType: MatOriginType;
  points: LatLng[];
};

export type PlaceMatsValidation =
  | { ok: true; value: ValidPlaceMatsInput }
  | { ok: false; error: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isMatOriginType(s: string): s is MatOriginType {
  return (MAT_ORIGIN_TYPES as readonly string[]).includes(s);
}

export function isValidDateString(s: string): boolean {
  if (!DATE_PATTERN.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validatePlaceMatsInput(input: PlaceMatsInput): PlaceMatsValidation {
  if (!UUID_PATTERN.test(input.fieldId)) return { ok: false, error: "圃場が不正です" };
  if (!UUID_PATTERN.test(input.cultivarId)) return { ok: false, error: "品種を選んでください" };
  if (!isValidDateString(input.plantedAt))
    return { ok: false, error: "植え付け日を YYYY-MM-DD で入力してください" };
  if (!isMatOriginType(input.originType)) return { ok: false, error: "苗の種類を選んでください" };
  if (!Array.isArray(input.points) || input.points.length === 0)
    return { ok: false, error: "配置する株がありません" };
  if (input.points.length > MAX_MATS_PER_PLACEMENT)
    return { ok: false, error: `一度に配置できる株は ${MAX_MATS_PER_PLACEMENT} 株までです` };
  for (const p of input.points) {
    if (
      typeof p?.lat !== "number" ||
      typeof p?.lng !== "number" ||
      !Number.isFinite(p.lat) ||
      !Number.isFinite(p.lng) ||
      p.lat < -90 ||
      p.lat > 90 ||
      p.lng < -180 ||
      p.lng > 180
    ) {
      return { ok: false, error: "株の位置が不正です" };
    }
  }
  return {
    ok: true,
    value: {
      fieldId: input.fieldId,
      cultivarId: input.cultivarId,
      plantedAt: input.plantedAt,
      originType: input.originType,
      points: input.points.map((p) => ({ lat: p.lat, lng: p.lng })),
    },
  };
}
