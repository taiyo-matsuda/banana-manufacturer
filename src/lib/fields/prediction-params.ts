// 圃場の詳細の「予測の設定」（3-2）: 圃場 × 品種の基準温度・目標積算温度の上書き（field_cultivar_params）の入力の検証。
// 空欄は「品種の既定を使う」（null で保存）。範囲は 0020 の検査と同じ。UI に依存しない純粋関数。
import { BASE_TEMP_MAX_C, BASE_TEMP_MIN_C, TARGET_GDD_MAX, TARGET_GDD_MIN } from "../gdd";

export type PredictionParamsInput = {
  baseTemp: string;
  targetGdd: string;
};

export type PredictionParamsErrors = Partial<Record<keyof PredictionParamsInput, string>>;

export type PredictionParamsValue = {
  baseTempC: number | null;
  floweringToHarvestGdd: number | null;
};

export type PredictionParamsValidation =
  | { ok: true; value: PredictionParamsValue }
  | { ok: false; errors: PredictionParamsErrors };

// Server Action（useActionState）の戻り値
export type PredictionParamsState = {
  error: string | null;
  errors: PredictionParamsErrors;
  values: PredictionParamsInput;
  saved: number; // 保存できた回数
  attempts: number; // 送信を処理した回数（成功・失敗とも。E2E が応答を待つ目印）
  message: string | null;
};

function parseNumber(s: string): number | null | "invalid" | "decimals" {
  const t = s.trim().replace(/[０-９．－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (t === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(t)) return "invalid";
  if (!/^-?\d+(\.\d)?$/.test(t)) return "decimals";
  return Number(t);
}

export function validatePredictionParams(input: PredictionParamsInput): PredictionParamsValidation {
  const errors: PredictionParamsErrors = {};

  const base = parseNumber(input.baseTemp);
  let baseTempC: number | null = null;
  if (base === "invalid") errors.baseTemp = "基準温度は数値で入力してください";
  else if (base === "decimals") errors.baseTemp = "基準温度は小数点以下 1 桁までで入力してください";
  else if (base !== null) {
    if (base < BASE_TEMP_MIN_C || base > BASE_TEMP_MAX_C)
      errors.baseTemp = `基準温度は ${BASE_TEMP_MIN_C}〜${BASE_TEMP_MAX_C}℃ の範囲で入力してください`;
    else baseTempC = base;
  }

  const target = parseNumber(input.targetGdd);
  let floweringToHarvestGdd: number | null = null;
  if (target === "invalid") errors.targetGdd = "目標積算温度は数値で入力してください";
  else if (target === "decimals") errors.targetGdd = "目標積算温度は小数点以下 1 桁までで入力してください";
  else if (target !== null) {
    if (target < TARGET_GDD_MIN || target > TARGET_GDD_MAX)
      errors.targetGdd = `目標積算温度は ${TARGET_GDD_MIN}〜${TARGET_GDD_MAX.toLocaleString("ja-JP")} ℃・日の範囲で入力してください`;
    else floweringToHarvestGdd = target;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { baseTempC, floweringToHarvestGdd } };
}

// 保存済みの値（numeric は文字列で返ることがある）→ 入力欄の文字列（null は空欄）
export function paramToInput(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return "";
  return String(Number(v));
}
