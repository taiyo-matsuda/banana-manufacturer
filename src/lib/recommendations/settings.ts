// 提案の設定（3-4・3-5、prediction.md 6 章）: 圃場ごとの値（field_recommendation_params）。空なら暫定の既定値（01_requirements.md 10 章）。
// 範囲は 0022・0023 の検査と同じ。UI に依存しない純粋関数。
// 3-5（0023）: 収穫後の追肥の期限 M（収穫から M 日、既定 7）、枯葉処理の間隔 X（既定 30）、追肥の標準量（量と単位。既定値なし）。
import { FERTILIZER_UNITS, type FertilizerUnit, formatAmount, isFertilizerUnit, parseAmount } from "../fertilize";

export const BAG_AFTER_DAYS_DEFAULT = 14; // 袋掛け・摘蕾: 出蕾から 14 日
export const BAG_AFTER_DAYS_MIN = 1;
export const BAG_AFTER_DAYS_MAX = 60;
export const HARVEST_WINDOW_DAYS_DEFAULT = 7; // 収穫期: 予測の下限の 7 日前
export const HARVEST_WINDOW_DAYS_MIN = 0;
export const HARVEST_WINDOW_DAYS_MAX = 30;
export const FERTILIZE_AFTER_HARVEST_DAYS_DEFAULT = 7; // 収穫後の追肥: 収穫から 7 日以内
export const FERTILIZE_AFTER_HARVEST_DAYS_MIN = 1;
export const FERTILIZE_AFTER_HARVEST_DAYS_MAX = 60;
export const DEAD_LEAVES_INTERVAL_DAYS_DEFAULT = 30; // 枯葉処理: 最後の枯葉処理（なければ採用・植え付け）から 30 日
export const DEAD_LEAVES_INTERVAL_DAYS_MIN = 1;
export const DEAD_LEAVES_INTERVAL_DAYS_MAX = 365;

// 追肥の標準量（圃場ごと。未設定なら null）
export type StandardFertilizerAmount = { amount: number; unit: FertilizerUnit };

export type RecommendationSettings = {
  bagAfterDays: number;
  harvestWindowDays: number;
  fertilizeAfterHarvestDays: number;
  deadLeavesIntervalDays: number;
  standardAmount: StandardFertilizerAmount | null;
};

export const DEFAULT_RECOMMENDATION_SETTINGS: RecommendationSettings = {
  bagAfterDays: BAG_AFTER_DAYS_DEFAULT,
  harvestWindowDays: HARVEST_WINDOW_DAYS_DEFAULT,
  fertilizeAfterHarvestDays: FERTILIZE_AFTER_HARVEST_DAYS_DEFAULT,
  deadLeavesIntervalDays: DEAD_LEAVES_INTERVAL_DAYS_DEFAULT,
  standardAmount: null,
};

export type RecommendationParamsRow = {
  bag_after_days?: number | string | null;
  harvest_window_days?: number | string | null;
  fertilize_after_harvest_days?: number | string | null;
  dead_leaves_interval_days?: number | string | null;
  fertilizer_standard_amount?: number | string | null;
  fertilizer_standard_unit?: string | null;
};

// field_recommendation_params の列（読み出し用）
export const RECOMMENDATION_PARAMS_COLUMNS =
  "bag_after_days, harvest_window_days, fertilize_after_harvest_days, dead_leaves_interval_days, fertilizer_standard_amount, fertilizer_standard_unit";

// DB の行（null は既定値）→ 設定
export function resolveRecommendationSettings(row: RecommendationParamsRow | null | undefined): RecommendationSettings {
  const pick = (v: number | string | null | undefined, fallback: number) => (v === null || v === undefined ? fallback : Number(v));
  const amount = row?.fertilizer_standard_amount;
  const unit = row?.fertilizer_standard_unit;
  return {
    bagAfterDays: pick(row?.bag_after_days, BAG_AFTER_DAYS_DEFAULT),
    harvestWindowDays: pick(row?.harvest_window_days, HARVEST_WINDOW_DAYS_DEFAULT),
    fertilizeAfterHarvestDays: pick(row?.fertilize_after_harvest_days, FERTILIZE_AFTER_HARVEST_DAYS_DEFAULT),
    deadLeavesIntervalDays: pick(row?.dead_leaves_interval_days, DEAD_LEAVES_INTERVAL_DAYS_DEFAULT),
    standardAmount: amount !== null && amount !== undefined && isFertilizerUnit(unit) ? { amount: Number(amount), unit } : null,
  };
}

// 提案の一覧に出す追肥の量。標準量が未設定なら量を出さず、設定を促す
export const STANDARD_AMOUNT_MISSING = "圃場の標準量を設定してください";
export function standardAmountLabel(standard: StandardFertilizerAmount | null): string {
  return standard ? `量: 圃場の標準量 ${formatAmount(standard.amount)} ${standard.unit}` : STANDARD_AMOUNT_MISSING;
}

// 圃場の詳細の「提案の設定」の入力
export type RecommendationParamsInput = {
  bagAfterDays: string;
  harvestWindowDays: string;
  fertilizeAfterHarvestDays: string;
  deadLeavesIntervalDays: string;
  standardAmount: string;
  standardUnit: string;
};
export type RecommendationParamsErrors = Partial<Record<keyof RecommendationParamsInput, string>>;
export type RecommendationParamsValue = {
  bagAfterDays: number | null;
  harvestWindowDays: number | null;
  fertilizeAfterHarvestDays: number | null;
  deadLeavesIntervalDays: number | null;
  standardAmount: number | null;
  standardUnit: FertilizerUnit | null; // 標準量が空なら null
};
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

const toHalfWidth = (s: string) => s.replace(/[０-９．]/g, (c) => (c === "．" ? "." : String.fromCharCode(c.charCodeAt(0) - 0xfee0)));

function parseInteger(s: string): number | null | "invalid" {
  const t = toHalfWidth(s.trim());
  if (t === "") return null;
  if (!/^\d+$/.test(t)) return "invalid";
  return Number(t);
}

export function validateRecommendationParams(input: RecommendationParamsInput): RecommendationParamsValidation {
  const errors: RecommendationParamsErrors = {};
  const check = (
    key: "bagAfterDays" | "harvestWindowDays" | "fertilizeAfterHarvestDays" | "deadLeavesIntervalDays",
    label: string,
    min: number,
    max: number,
  ): number | null => {
    const v = parseInteger(input[key] ?? "");
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
  const fertilizeAfterHarvestDays = check(
    "fertilizeAfterHarvestDays",
    "収穫後の追肥の日数",
    FERTILIZE_AFTER_HARVEST_DAYS_MIN,
    FERTILIZE_AFTER_HARVEST_DAYS_MAX,
  );
  const deadLeavesIntervalDays = check(
    "deadLeavesIntervalDays",
    "枯葉処理の間隔",
    DEAD_LEAVES_INTERVAL_DAYS_MIN,
    DEAD_LEAVES_INTERVAL_DAYS_MAX,
  );

  // 標準量: 空なら未設定（単位も保存しない）。量を入れたら単位は必須
  let standardAmount: number | null = null;
  let standardUnit: FertilizerUnit | null = null;
  const amountText = toHalfWidth((input.standardAmount ?? "").trim());
  if (amountText !== "") {
    const parsed = parseAmount(amountText);
    if (parsed.ok) standardAmount = parsed.value;
    else errors.standardAmount = parsed.error.replace(/^量/, "標準量");
    if (isFertilizerUnit(input.standardUnit)) standardUnit = input.standardUnit;
    else errors.standardUnit = `単位を選んでください（${FERTILIZER_UNITS.join(" / ")}）`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { bagAfterDays, harvestWindowDays, fertilizeAfterHarvestDays, deadLeavesIntervalDays, standardAmount, standardUnit },
  };
}
