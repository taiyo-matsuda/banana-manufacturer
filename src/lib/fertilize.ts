// 施肥の一括入力（2-4、要件 4.4・UC-5、画面 5）の純粋ロジック。UI・DB に依存しない。
//
// - 入力は圃場一括（日付・肥料名・量・単位）＋例外の株だけ量を変える・外す
// - 保存は株ごとの fertilized イベント（target_type=mat、payload {fertilizer, amount, unit, batch_id}）。
//   1 回の確定で 1 つの batch_id。量は株ごとの値（個別に変えていない株は上の量）
// - 画面（Client Component）と Server Action の両方で同じ検証を使う（サーバー側の検証が正本）
import { isValidDateString } from "./mats/placement";
import { todayJst } from "./stemEvents";

export const FERTILIZER_UNITS = ["kg", "g", "L", "mL"] as const;
export type FertilizerUnit = (typeof FERTILIZER_UNITS)[number];
export const DEFAULT_FERTILIZER_UNIT: FertilizerUnit = "kg";

export const MAX_FERTILIZER_NAME_LENGTH = 100;
export const MAX_AMOUNT = 100_000;
export const AMOUNT_DECIMALS = 3;
// 肥料名の候補の数（直近に使ったものから）
export const MAX_FERTILIZER_SUGGESTIONS = 20;

export function isFertilizerUnit(v: unknown): v is FertilizerUnit {
  return typeof v === "string" && (FERTILIZER_UNITS as readonly string[]).includes(v);
}

export type Parse<T> = { ok: true; value: T } | { ok: false; error: string };

// --- 入力の解釈 ------------------------------------------------------------------

const AMOUNT_PATTERN = new RegExp(`^\\d+(\\.\\d{1,${AMOUNT_DECIMALS}})?$`);
export const AMOUNT_INVALID_MESSAGE = `量は 0 より大きい数（小数 ${AMOUNT_DECIMALS} 桁まで）で入力してください`;

// 量: 正の数（小数 3 桁まで）。空・0 以下・数字以外は理由付きで拒否
export function parseAmount(input: string | null | undefined): Parse<number> {
  const s = (input ?? "").trim();
  if (s === "") return { ok: false, error: "量を入力してください" };
  if (!AMOUNT_PATTERN.test(s)) return { ok: false, error: AMOUNT_INVALID_MESSAGE };
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: AMOUNT_INVALID_MESSAGE };
  if (n > MAX_AMOUNT) return { ok: false, error: `量は ${MAX_AMOUNT} 以下で入力してください` };
  return { ok: true, value: n };
}

// サーバーで受け取った数値の量（画面からは parseAmount 済みの数値が届く。改ざんされた値を拒否する）
export function isValidAmountNumber(n: unknown): n is number {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) return false;
  return Math.abs(Math.round(n * 10 ** AMOUNT_DECIMALS) - n * 10 ** AMOUNT_DECIMALS) < 1e-6;
}

// 肥料名: 前後の空白を取る。必須、100 文字まで
export function parseFertilizerName(input: string | null | undefined): Parse<string> {
  const s = (input ?? "").trim();
  if (s === "") return { ok: false, error: "肥料名を入力してください" };
  if (s.length > MAX_FERTILIZER_NAME_LENGTH) {
    return { ok: false, error: `肥料名は ${MAX_FERTILIZER_NAME_LENGTH} 文字以内で入力してください` };
  }
  return { ok: true, value: s };
}

// 日付: YYYY-MM-DD、未来の日付は拒否（日本時間）
export function parseFertilizeDate(input: string | null | undefined, now: Date = new Date()): Parse<string> {
  const s = (input ?? "").trim();
  if (!isValidDateString(s)) return { ok: false, error: "日付を YYYY-MM-DD で入力してください" };
  if (s > todayJst(now)) return { ok: false, error: "未来の日付は記録できません" };
  return { ok: true, value: s };
}

// --- 合計 ------------------------------------------------------------------------

// 小数の足し算の誤差を避けるため、小数 3 桁の整数にしてから足す
const SCALE = 10 ** AMOUNT_DECIMALS;
export function sumAmounts(amounts: readonly number[]): number {
  let total = 0;
  for (const a of amounts) total += Math.round(a * SCALE);
  return total / SCALE;
}

// 量の表示（末尾の 0 は付けない。例: 0.5 / 12 / 1.25）
export function formatAmount(n: number): string {
  return String(Number(n.toFixed(AMOUNT_DECIMALS)));
}

// --- 一覧（対象の株・個別の量）から確定する内容を作る -------------------------------------

export type FertilizePlanInput = {
  matIds: readonly string[]; // 一覧の株（株コード順）
  excluded: ReadonlySet<string>; // 外した株
  overrides: ReadonlyMap<string, string>; // 量を個別に変えた株（入力中の文字列）
  baseAmount: string; // 上の量（入力中の文字列）
};

export type FertilizePlan = {
  items: { matId: string; amount: number }[]; // 対象の株（一覧の順）。量が不正な株は含まない
  selectedCount: number; // 対象の株数（外していない株）
  total: number | null; // 合計量。量が不正な株があれば null
  baseError: string | null; // 上の量が不正（それを使う株があるときだけ）
  rowErrors: Map<string, string>; // 個別の量が不正な株
};

export function buildFertilizePlan({ matIds, excluded, overrides, baseAmount }: FertilizePlanInput): FertilizePlan {
  const base = parseAmount(baseAmount);
  const items: { matId: string; amount: number }[] = [];
  const rowErrors = new Map<string, string>();
  let selectedCount = 0;
  let usesBase = false;
  for (const matId of matIds) {
    if (excluded.has(matId)) continue;
    selectedCount++;
    const override = overrides.get(matId);
    if (override === undefined) {
      usesBase = true;
      if (base.ok) items.push({ matId, amount: base.value });
      continue;
    }
    const parsed = parseAmount(override);
    if (parsed.ok) items.push({ matId, amount: parsed.value });
    else rowErrors.set(matId, parsed.error);
  }
  const baseError = usesBase && !base.ok ? base.error : null;
  const total = baseError === null && rowErrors.size === 0 ? sumAmounts(items.map((i) => i.amount)) : null;
  return { items, selectedCount, total, baseError, rowErrors };
}

// --- 確定の入力（画面 → Server Action）の検証 --------------------------------------

export type FertilizeSubmission = {
  batchId: string;
  fieldId: string;
  date: string;
  fertilizer: string;
  unit: string;
  items: { matId: string; amount: number }[];
};

export type ValidFertilizeSubmission = {
  batchId: string;
  fieldId: string;
  date: string;
  fertilizer: string;
  unit: FertilizerUnit;
  items: { matId: string; amount: number }[];
};

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const NO_TARGET_MESSAGE = "対象の株を 1 株以上選んでください";
export const RELOAD_MESSAGE = "画面を再読み込みしてやり直してください";

export type SubmissionErrors = {
  date?: string;
  fertilizer?: string;
  unit?: string;
  targets?: string;
  form?: string;
};

export function validateFertilizeSubmission(
  input: FertilizeSubmission,
  now: Date = new Date(),
): { ok: true; value: ValidFertilizeSubmission } | { ok: false; errors: SubmissionErrors } {
  const errors: SubmissionErrors = {};
  if (!UUID_PATTERN.test(input?.batchId ?? "") || !UUID_PATTERN.test(input?.fieldId ?? "")) {
    return { ok: false, errors: { form: RELOAD_MESSAGE } };
  }
  const date = parseFertilizeDate(input.date, now);
  if (!date.ok) errors.date = date.error;
  const fertilizer = parseFertilizerName(input.fertilizer);
  if (!fertilizer.ok) errors.fertilizer = fertilizer.error;
  if (!isFertilizerUnit(input.unit)) errors.unit = "単位を選んでください";

  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length === 0) {
    errors.targets = NO_TARGET_MESSAGE;
  } else {
    const seen = new Set<string>();
    for (const item of items) {
      if (!item || typeof item.matId !== "string" || !UUID_PATTERN.test(item.matId) || seen.has(item.matId)) {
        errors.targets = RELOAD_MESSAGE;
        break;
      }
      seen.add(item.matId);
      if (!isValidAmountNumber(item.amount)) {
        errors.targets = AMOUNT_INVALID_MESSAGE;
        break;
      }
    }
  }
  if (Object.keys(errors).length > 0 || !date.ok || !fertilizer.ok || !isFertilizerUnit(input.unit)) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      batchId: input.batchId,
      fieldId: input.fieldId,
      date: date.value,
      fertilizer: fertilizer.value,
      unit: input.unit,
      items: items.map((i) => ({ matId: i.matId, amount: i.amount })),
    },
  };
}

// 確定の内容の識別子（画面で batch_id を保持するか採番し直すかの判定に使う）。
// 肥料名は前後の空白を除いて比べる。対象の株と量は一覧の順
export function fertilizeSubmissionKey(input: Omit<FertilizeSubmission, "batchId">): string {
  return JSON.stringify([
    input.fieldId,
    input.date,
    (input.fertilizer ?? "").trim(),
    input.unit,
    input.items.map((i) => [i.matId, i.amount]),
  ]);
}

// 対象の株が、その圃場の撤去していない株に含まれるか（サーバーで読んだ株の id と照らす）
export function findInvalidTargets(matIds: readonly string[], allowed: ReadonlySet<string>): string[] {
  return matIds.filter((id) => !allowed.has(id));
}

// --- 候補・既定値 -----------------------------------------------------------------

type PayloadLike = Record<string, unknown> | null | undefined;

// 肥料名の候補: 直近の fertilized イベントの payload から、新しい順に重複を除いて max 件
export function fertilizerSuggestions(payloads: readonly PayloadLike[], max = MAX_FERTILIZER_SUGGESTIONS): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of payloads) {
    const name = typeof p?.fertilizer === "string" ? p.fertilizer.trim() : "";
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}

// 単位の既定値: 前回（直近の fertilized イベント）の単位。なければ kg
export function defaultFertilizerUnit(payloads: readonly PayloadLike[]): FertilizerUnit {
  for (const p of payloads) {
    if (isFertilizerUnit(p?.unit)) return p.unit;
  }
  return DEFAULT_FERTILIZER_UNIT;
}

// 株ごとの fertilized イベントの行（organization_id は渡さない。トリガーが target の株からコピーする）
export function fertilizedEventRows(input: ValidFertilizeSubmission, occurredAt: string, recordedBy: string) {
  return input.items.map((item) => ({
    type: "fertilized" as const,
    target_type: "mat" as const,
    target_id: item.matId,
    occurred_at: occurredAt,
    recorded_by: recordedBy,
    payload: { fertilizer: input.fertilizer, amount: item.amount, unit: input.unit, batch_id: input.batchId },
  }));
}

// 履歴の表示（例: 「化成肥料 0.5 kg」）
export function fertilizedValueText(payload: PayloadLike): string {
  const p = payload ?? {};
  const name = typeof p.fertilizer === "string" ? p.fertilizer : "";
  const amount = typeof p.amount === "number" ? formatAmount(p.amount) : "";
  const unit = typeof p.unit === "string" ? p.unit : "";
  return [name, [amount, unit].filter(Boolean).join(" ")].filter(Boolean).join(" ");
}

// 確認ダイアログ・完了の文言（例: 「5 株に合計 2.5 kg」）
export function fertilizeSummaryText(count: number, total: number, unit: string): string {
  return `${count} 株に合計 ${formatAmount(total)} ${unit}`;
}
