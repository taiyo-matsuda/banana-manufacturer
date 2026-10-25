// 吸芽の発生の記録（2-1）の純粋ロジック。UI・DB に依存しない。要件 3 章「吸芽の扱い」「残す吸芽の決め方」・4.3・5.3、
// data-model.md の sucker_emerged。
//
// - 吸芽は親茎（栽培中 = active / flowered）に対して記録する。既定の親茎は栽培中の茎のうち最も世代の若い（最も古い）茎
// - payload: { sucker_stem_id, parent_cumulative_leaves, earliest_at, direction, sucker_type }
//   parent_cumulative_leaves はその時点の親の累計葉数（端末で計算。残す吸芽の基準 X の根拠）
// - DB の RPC record_sucker_emerged（supabase/migrations/0010）が吸芽の茎（status=sucker）とイベントを 1 トランザクションで作る
// - 吸芽は最大 3 本の制約に数えない（0001 のトリガーは active / flowered だけを数える）
import { isValidDateString } from "./mats/placement";
import { todayJst } from "./stemEvents";

// --- 方向（8 方位） --------------------------------------------------------------

export const SUCKER_DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type SuckerDirection = (typeof SUCKER_DIRECTIONS)[number];

export const SUCKER_DIRECTION_LABELS: Record<SuckerDirection, string> = {
  N: "北",
  NE: "北東",
  E: "東",
  SE: "南東",
  S: "南",
  SW: "南西",
  W: "西",
  NW: "北西",
};

// 画面の 3×3 の配置（上が北）。中央は空き（null）
export const SUCKER_DIRECTION_GRID: readonly (SuckerDirection | null)[] = ["NW", "N", "NE", "W", null, "E", "SW", "S", "SE"];

export const isSuckerDirection = (s: string): s is SuckerDirection => (SUCKER_DIRECTIONS as readonly string[]).includes(s);

export function suckerDirectionLabel(direction: unknown): string {
  return typeof direction === "string" ? ((SUCKER_DIRECTION_LABELS as Record<string, string>)[direction] ?? direction) : "";
}

// --- 種類 ------------------------------------------------------------------------

export const SUCKER_TYPES = ["sword", "water"] as const;
export type SuckerType = (typeof SUCKER_TYPES)[number];

export const SUCKER_TYPE_LABELS: Record<SuckerType, string> = {
  sword: "剣葉",
  water: "水吸芽",
};

export const SUCKER_TYPE_DESCRIPTIONS: Record<SuckerType, string> = {
  sword: "葉が細く、親にしっかり付いている",
  water: "葉が幅広で、付き方が弱い",
};

export const isSuckerType = (s: string): s is SuckerType => (SUCKER_TYPES as readonly string[]).includes(s);

export function suckerTypeLabel(type: unknown): string {
  return typeof type === "string" ? ((SUCKER_TYPE_LABELS as Record<string, string>)[type] ?? type) : "";
}

// --- 親茎 ------------------------------------------------------------------------

// 吸芽を記録できる親茎の状態（RPC と同じ）
export const SUCKER_PARENT_STATUSES = ["active", "flowered"] as const;

export type ParentCandidate = { id: string; generation: number; status: string; started_at: string };

export function canHaveSucker(status: string): boolean {
  return (SUCKER_PARENT_STATUSES as readonly string[]).includes(status);
}

// 親茎の候補（栽培中の茎）を世代の若い順（同じ世代は started_at の早い順、さらに id 順）に
export function suckerParentCandidates<T extends ParentCandidate>(stems: readonly T[]): T[] {
  return stems
    .filter((s) => canHaveSucker(s.status))
    .sort((a, b) => a.generation - b.generation || a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
}

// 既定の親茎: 候補の先頭（最も世代の若い = 最も古い茎）。候補がなければ null
export function defaultSuckerParent<T extends ParentCandidate>(stems: readonly T[]): T | null {
  return suckerParentCandidates(stems)[0] ?? null;
}

export const NO_SUCKER_PARENT_MESSAGE = "栽培中の茎がないため、吸芽を記録できません";

// --- 入力の解釈と payload --------------------------------------------------------

export type SuckerFormInput = {
  parentStemId: string;
  direction: string;
  suckerType: string;
  date: string; // 確認日 YYYY-MM-DD
  earliestAt?: string; // 前回訪問日（任意）
};

export type ParsedSucker = {
  parentStemId: string;
  direction: SuckerDirection;
  suckerType: SuckerType;
  date: string;
  earliestAt: string | null;
};

export type SuckerParse = { ok: true; value: ParsedSucker } | { ok: false; error: string };

export function parseSuckerInput(input: SuckerFormInput, candidates: readonly ParentCandidate[]): SuckerParse {
  const parentStemId = input.parentStemId.trim();
  if (!candidates.some((c) => c.id === parentStemId)) return { ok: false, error: "親茎を選んでください" };
  const direction = input.direction.trim();
  if (!isSuckerDirection(direction)) return { ok: false, error: "方向を選んでください" };
  const suckerType = input.suckerType.trim();
  if (!isSuckerType(suckerType)) return { ok: false, error: "種類を選んでください" };
  const date = input.date.trim();
  if (!isValidDateString(date)) return { ok: false, error: "確認日を YYYY-MM-DD で入力してください" };
  const earliest = (input.earliestAt ?? "").trim();
  if (earliest !== "" && !isValidDateString(earliest)) {
    return { ok: false, error: "前回訪問日を YYYY-MM-DD で入力してください（空でもよい）" };
  }
  if (earliest !== "" && earliest > date) return { ok: false, error: "前回訪問日は確認日より前の日付にしてください" };
  return { ok: true, value: { parentStemId, direction, suckerType, date, earliestAt: earliest === "" ? null : earliest } };
}

export type SuckerEmergedPayload = {
  sucker_stem_id: string;
  parent_cumulative_leaves: number;
  earliest_at: string | null;
  direction: SuckerDirection;
  sucker_type: SuckerType;
};

export function buildSuckerPayload(args: {
  suckerStemId: string;
  parentCumulativeLeaves: number;
  earliestAt: string | null;
  direction: SuckerDirection;
  suckerType: SuckerType;
}): SuckerEmergedPayload {
  return {
    sucker_stem_id: args.suckerStemId,
    parent_cumulative_leaves: args.parentCumulativeLeaves,
    earliest_at: args.earliestAt,
    direction: args.direction,
    sucker_type: args.suckerType,
  };
}

// 履歴の表示（親茎のイベント）: 「北東・剣葉・親の累計 18 枚」
export function suckerEmergedValueText(payload: Record<string, unknown> | null | undefined): string {
  const p = payload ?? {};
  const parts = [suckerDirectionLabel(p.direction), suckerTypeLabel(p.sucker_type)].filter((s) => s !== "");
  if (typeof p.parent_cumulative_leaves === "number") parts.push(`親の累計 ${p.parent_cumulative_leaves} 枚`);
  return parts.join("・");
}

// その時点（確認日 YYYY-MM-DD の終わりまで、日本時間）の親の累計葉数 = 初期葉数 + 確認日までの Σ leaves_new。
// 観測は現在の値（superseded_by が null のもの）を渡す。未送信の観測も含めて渡す（端末で計算）
export function cumulativeLeavesAsOf(
  initialLeafCount: number,
  observations: readonly { type: string; value: number; observed_at: string }[],
  date: string,
): number {
  return observations
    .filter((o) => o.type === "leaves_new" && todayJst(new Date(o.observed_at)) <= date)
    .reduce((sum, o) => sum + Number(o.value), initialLeafCount);
}

// 前回訪問日の既定値: 確認日（YYYY-MM-DD）より前（確認日を含まない）の最新の観測日（日本時間）。なければ null。
// 同じ日に新葉を記録してから吸芽を記録しても、前回訪問日が確認日と同じにならないように
export function defaultSuckerEarliestAt(observedAts: readonly string[], date: string): string | null {
  let latest: string | null = null;
  for (const at of observedAts) {
    const t = new Date(at);
    if (Number.isNaN(t.getTime())) continue;
    const d = todayJst(t);
    if (d < date && (latest === null || d > latest)) latest = d;
  }
  return latest;
}
