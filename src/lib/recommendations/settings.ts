// 提案の設定（3-4、prediction.md 6 章）: 圃場ごとの値（field_recommendation_params）。空なら暫定の既定値（01_requirements.md 10 章）。
// 範囲は 0022 の検査と同じ。UI に依存しない純粋関数。3-5 で追肥・枯葉処理の値を足す。

export const BAG_AFTER_DAYS_DEFAULT = 14; // 袋掛け・摘蕾: 出蕾から 14 日
export const BAG_AFTER_DAYS_MIN = 1;
export const BAG_AFTER_DAYS_MAX = 60;
export const HARVEST_WINDOW_DAYS_DEFAULT = 7; // 収穫期: 予測の下限の 7 日前
export const HARVEST_WINDOW_DAYS_MIN = 0;
export const HARVEST_WINDOW_DAYS_MAX = 30;

export type RecommendationSettings = {
  bagAfterDays: number;
  harvestWindowDays: number;
};

export const DEFAULT_RECOMMENDATION_SETTINGS: RecommendationSettings = {
  bagAfterDays: BAG_AFTER_DAYS_DEFAULT,
  harvestWindowDays: HARVEST_WINDOW_DAYS_DEFAULT,
};

// DB の行（null は既定値）→ 設定
export function resolveRecommendationSettings(
  row: { bag_after_days?: number | string | null; harvest_window_days?: number | string | null } | null | undefined,
): RecommendationSettings {
  const pick = (v: number | string | null | undefined, fallback: number) => (v === null || v === undefined ? fallback : Number(v));
  return {
    bagAfterDays: pick(row?.bag_after_days, BAG_AFTER_DAYS_DEFAULT),
    harvestWindowDays: pick(row?.harvest_window_days, HARVEST_WINDOW_DAYS_DEFAULT),
  };
}

// 圃場の詳細の「提案の設定」の入力
export type RecommendationParamsInput = { bagAfterDays: string; harvestWindowDays: string };
export type RecommendationParamsErrors = Partial<Record<keyof RecommendationParamsInput, string>>;
export type RecommendationParamsValue = { bagAfterDays: number | null; harvestWindowDays: number | null };
export type RecommendationParamsValidation =
  | { ok: true; value: RecommendationParamsValue }
  | { ok: false; errors: RecommendationParamsErrors };

// Server Action（useActionState）の戻り値
export type RecommendationParamsState = {
  error: string | null;
  errors: RecommendationParamsErrors;
  values: RecommendationParamsInput;
  saved: number;
  attempts: number;
  message: string | null;
};

function parseInteger(s: string): number | null | "invalid" {
  const t = s.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return "invalid";
  return Number(t);
}

export function validateRecommendationParams(input: RecommendationParamsInput): RecommendationParamsValidation {
  const errors: RecommendationParamsErrors = {};
  const check = (
    key: keyof RecommendationParamsInput,
    label: string,
    min: number,
    max: number,
  ): number | null => {
    const v = parseInteger(input[key]);
    if (v === "invalid") {
      errors[key] = `${label}は整数（日数）で入力してください`;
      return null;
    }
    if (v !== null && (v < min || v > max)) {
      errors[key] = `${label}は ${min}〜${max} 日の範囲で入力してください`;
      return null;
    }
    return v;
  };
  const bagAfterDays = check("bagAfterDays", "袋掛け・摘蕾の日数", BAG_AFTER_DAYS_MIN, BAG_AFTER_DAYS_MAX);
  const harvestWindowDays = check("harvestWindowDays", "収穫期の日数", HARVEST_WINDOW_DAYS_MIN, HARVEST_WINDOW_DAYS_MAX);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { bagAfterDays, harvestWindowDays } };
}
