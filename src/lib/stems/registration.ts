// 茎の登録（1-5）の純粋ロジック。UI・DB に依存しない。
//
// - 株ごとに栽培中（active / flowered）の茎は最大 3 本。正本は DB トリガー `stems_max_active`（0001）で、
//   アプリ側は登録前の本数で判定して UI を出し分け、トリガーのエラーも日本語にして画面に出す（二重の防御）
// - 植え付け時の茎は generation=1、status=active、started_at=adopted_at=植え付け日、initial_leaf_count=初期葉数
// - 2 本目以降（子・孫）は本来は吸芽の採用（ステップ 2）で作られる。1-5 では完了条件 2（4 本目の拒否）の検証のため、
//   株の詳細の「茎を登録」で `generation = 既存の最大 + 1`、parent_stem_id = 直前の世代の茎 として追加できる。
//   ステップ 2 で吸芽の採用に置き換える予定
import { isValidDateString } from "../mats/placement";
import { parseInitialLeafCount } from "./leaf-count";

export { INITIAL_LEAF_COUNT_ERROR, type LeafCountParse, parseInitialLeafCount } from "./leaf-count";

export const MAX_ACTIVE_STEMS = 3;

// 「本数」に数える状態（DB トリガーと同じ）
export const COUNTED_STEM_STATUSES = ["active", "flowered"] as const;

export type StemForCount = { status: string };
export type StemForGeneration = { id: string; generation: number; started_at: string };

export function countActiveStems(stems: readonly StemForCount[]): number {
  return stems.filter((s) => (COUNTED_STEM_STATUSES as readonly string[]).includes(s.status)).length;
}

export const MAX_ACTIVE_STEMS_MESSAGE = `この株には栽培中の茎が ${MAX_ACTIVE_STEMS} 本あります。これ以上は登録できません`;

export type AddStemCheck = { ok: true } | { ok: false; reason: string };

// 登録前の判定（UI の出し分け用）。DB の正本はトリガー
export function canAddActiveStem(stems: readonly StemForCount[]): AddStemCheck {
  if (countActiveStems(stems) >= MAX_ACTIVE_STEMS) return { ok: false, reason: MAX_ACTIVE_STEMS_MESSAGE };
  return { ok: true };
}

// 次の茎の世代と親茎。茎がなければ親（generation=1、親茎なし）。
// あれば最大の世代 + 1。親茎は最大の世代の茎（同じ世代が複数なら started_at の遅いもの）
export function nextGeneration(stems: readonly StemForGeneration[]): {
  generation: number;
  parentStemId: string | null;
} {
  if (stems.length === 0) return { generation: 1, parentStemId: null };
  let parent = stems[0];
  for (const s of stems) {
    if (
      s.generation > parent.generation ||
      (s.generation === parent.generation && s.started_at.localeCompare(parent.started_at) > 0)
    ) {
      parent = s;
    }
  }
  return { generation: parent.generation + 1, parentStemId: parent.id };
}

// DB トリガー `stems_max_active` のエラーか（メッセージ: `mat <id> already has 3 active stems`）
export function isMaxActiveStemsError(error: { message?: string | null } | null | undefined): boolean {
  return /already has 3 active stems/.test(error?.message ?? "");
}

// 株の詳細「茎を登録」の入力
export type StemInput = {
  plantedAt: string; // YYYY-MM-DD
  initialLeafCount: string;
};

export type StemErrors = Partial<Record<keyof StemInput, string>>;

export type ValidStemInput = { plantedAt: string; initialLeafCount: number };

export type StemValidation = { ok: true; value: ValidStemInput } | { ok: false; errors: StemErrors };

export function validateStemInput(input: StemInput): StemValidation {
  const errors: StemErrors = {};
  const plantedAt = input.plantedAt.trim();
  if (!isValidDateString(plantedAt)) errors.plantedAt = "植え付け日を YYYY-MM-DD で入力してください";
  const leaves = parseInitialLeafCount(input.initialLeafCount);
  if (!leaves.ok) errors.initialLeafCount = leaves.error;
  else if (leaves.value === null) errors.initialLeafCount = "初期葉数を入力してください";
  if (Object.keys(errors).length > 0 || !leaves.ok || leaves.value === null) return { ok: false, errors };
  return { ok: true, value: { plantedAt, initialLeafCount: leaves.value } };
}

// 登録 Server Action の戻り値（useActionState の state）
export type RegisterStemState = {
  error: string | null;
  errors: StemErrors;
  values: StemInput;
  succeeded: number;
};

// 植え付け（または採用）で insert する stems の行。organization_id は渡さない（トリガーが mats からコピー）
export function newActiveStemRow(
  matId: string,
  input: ValidStemInput,
  next: { generation: number; parentStemId: string | null },
) {
  return {
    mat_id: matId,
    generation: next.generation,
    parent_stem_id: next.parentStemId,
    status: "active" as const,
    started_at: input.plantedAt,
    adopted_at: input.plantedAt,
    initial_leaf_count: input.initialLeafCount,
  };
}
