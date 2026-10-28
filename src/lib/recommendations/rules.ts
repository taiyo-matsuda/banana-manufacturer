// 提案のルール（3-4・3-5、prediction.md 6 章）。UI・DB に依存しない純粋関数。
//
// ルールは対象の種類ごとの配列に並べる（茎: STEM_RULES、株: MAT_RULES）。1 つのルールは:
// - propose: 対象の事実（茎・イベント・観測・推定）と設定・今日から「いま出すべき提案」を返す（出さないなら null）
// - completion: open の提案（rule_key）を done にする記録（対応する記録）を返す（なければ null）
// - owns: 同じ kind を複数のルールで出すとき（確認 = 検算ずれ / 重い被害）、その rule_key が自分のものか
// 評価（evaluate.ts）が、既存の提案（全状態）と突き合わせて「作るもの」「閉じるもの」を決める。
import { cumulativeLeavesByCheck, LEAF_CHECK_THRESHOLD } from "../leaves";
import { formatMonthDay } from "../prediction/harvest";
import { damageKindLabel } from "../stemEvents";
import { addDays } from "../weather/dates";
import type { RecommendationSettings } from "./settings";

export const RECOMMENDATION_KINDS = [
  "bag",
  "debud",
  "harvest_window",
  "fertilize_after_harvest",
  "remove_dead_leaves",
  "inspect",
] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

// 終了した茎（open の提案は「対象が終了」で dismissed）
export const ENDED_STEM_STATUSES: readonly string[] = ["lost", "harvested", "removed", "transplanted"];
// 栽培中・出蕾済み（枯葉処理・検算の対象）
const GROWING_STATUSES: readonly string[] = ["active", "flowered"];
export const ENDED_NOTE = "対象が終了";
export const DISMISSED_NOTE = "無視";

// 茎のイベント（訂正済み superseded_by を除いた現在のもの）
export type StemEventFact = {
  id: string;
  type: string;
  date: string; // 日本時間の日付
  recordedBy: string | null;
  occurredAt?: string; // ISO（検算で「現在の葉数」より前の枯葉処理かを見る）
  severity?: string | null; // damage のとき
  damageKind?: string | null; // damage のとき
  count?: number | null; // leaves_removed のとき
};

// 葉数の観測（現在の値。訂正済みを除く）
export type LeafObservationFact = {
  id: string;
  value: number;
  observedAt: string; // ISO
  observedBy: string | null;
};

// 訂正された行（superseded_by が付いた観測・イベント）→ 訂正した行（の記録者）
export type Replacement = { id: string; recordedBy: string | null };

export type StemFacts = {
  stemId: string;
  status: string;
  budEmergedAt: string | null; // 出蕾の確認日
  events: readonly StemEventFact[];
  // 収穫予測日（latest_estimates の harvest_date）の下限。推定が無い・予測できなかったなら null
  harvestLowerDate: string | null;
  settings: RecommendationSettings;
  // 3-5: 枯葉処理の起点（採用日、なければ発生・植え付けの日）
  adoptedAt?: string | null;
  startedAt?: string | null;
  // 3-5: 検算（1-6 と同じ式。初期葉数 + Σ新葉 と、最新の現在の葉数 + それまでの枯葉処理）
  initialLeafCount?: number | null;
  leavesNewSum?: number;
  leavesCurrent?: readonly LeafObservationFact[];
  // 3-5: 訂正された観測・イベントの id → 訂正した行
  replacedBy?: Readonly<Record<string, Replacement>>;
};

// 株の事実（3-5、収穫後の追肥）
export type MatFacts = {
  matId: string;
  status: string; // active / removed
  harvestDates: readonly string[]; // この株の収穫済みの茎の収穫日（stems.harvested_at）
  fertilizations: readonly { id: string; date: string; recordedBy: string | null }[]; // fertilized（現在の値）
  removal: { id: string; recordedBy: string | null } | null; // mat_removed のイベント（撤去済みのとき）
  settings: RecommendationSettings;
};

export type ProposalDraft = { ruleKey: string; dueAt: string; reason: string };
export type Completion = { note: string; recordedBy: string | null; eventId: string | null };

export type Rule<F> = {
  kind: RecommendationKind;
  owns?: (ruleKey: string) => boolean;
  propose: (facts: F, today: string) => ProposalDraft | null;
  completion: (facts: F, ruleKey: string) => Completion | null;
};
export type StemRule = Rule<StemFacts> & { targetType: "stem" };
export type MatRule = Rule<MatFacts> & { targetType: "mat" };

function latestEvent(stem: StemFacts, type: string): StemEventFact | null {
  let found: StemEventFact | null = null;
  for (const e of stem.events) if (e.type === type && (!found || e.date >= found.date)) found = e;
  return found;
}

const doneBy = (e: StemEventFact, note: string): Completion => ({ note, recordedBy: e.recordedBy, eventId: e.id });

// 袋掛け・摘蕾: 出蕾から N 日たって、その記録（bagged / debudded）がない出蕾済みの茎。期限は出蕾日 + N
function budAfterRule(kind: "bag" | "debud", eventType: "bagged" | "debudded", note: string): StemRule {
  return {
    kind,
    targetType: "stem",
    propose(stem, today) {
      if (stem.status !== "flowered" || !stem.budEmergedAt) return null;
      if (latestEvent(stem, eventType)) return null;
      const n = stem.settings.bagAfterDays;
      const dueAt = addDays(stem.budEmergedAt, n);
      if (dueAt > today) return null;
      return { ruleKey: "", dueAt, reason: `出蕾から ${n} 日（出蕾 ${formatMonthDay(stem.budEmergedAt)}）` };
    },
    completion: (stem) => {
      const e = latestEvent(stem, eventType);
      return e ? doneBy(e, note) : null;
    },
  };
}

// 収穫期: 収穫予測日の下限が「今日 + 収穫期の日数」以内（過ぎていても）の出蕾済みの茎。期限は下限の日
const harvestWindowRule: StemRule = {
  kind: "harvest_window",
  targetType: "stem",
  propose(stem, today) {
    if (stem.status !== "flowered" || !stem.harvestLowerDate) return null;
    if (latestEvent(stem, "harvested")) return null;
    if (stem.harvestLowerDate > addDays(today, stem.settings.harvestWindowDays)) return null;
    return {
      ruleKey: "",
      dueAt: stem.harvestLowerDate,
      reason: `積算温度が目安に近づいています（収穫予測の早い日 ${formatMonthDay(stem.harvestLowerDate)}）`,
    };
  },
  completion: (stem) => {
    const e = latestEvent(stem, "harvested");
    return e ? doneBy(e, "収穫を記録") : null;
  },
};

// --- 3-5 枯葉処理 ------------------------------------------------------------------------------------------
// 栽培中・出蕾済みの茎で、最後の枯葉処理（なければ採用日、なければ発生・植え付けの日）から X 日以上。期限は起点 + X。
// rule_key は起点（「leaves_removed:日付」/「start:日付」）。枯葉処理を記録するたびに起点が進み、次の回の提案になる。
// done: 起点より後（起点が採用・植え付けなら同じ日も含む）の枯葉処理
const DEAD_LEAVES_REMOVED = "leaves_removed:";
const DEAD_LEAVES_START = "start:";

function deadLeavesBase(stem: StemFacts): { key: string; date: string; removed: boolean } | null {
  const last = latestEvent(stem, "leaves_removed");
  if (last) return { key: `${DEAD_LEAVES_REMOVED}${last.date}`, date: last.date, removed: true };
  const start = stem.adoptedAt ?? stem.startedAt ?? null;
  return start ? { key: `${DEAD_LEAVES_START}${start}`, date: start, removed: false } : null;
}

const deadLeavesRule: StemRule = {
  kind: "remove_dead_leaves",
  targetType: "stem",
  propose(stem, today) {
    if (!GROWING_STATUSES.includes(stem.status)) return null;
    const base = deadLeavesBase(stem);
    if (!base) return null;
    const x = stem.settings.deadLeavesIntervalDays;
    const dueAt = addDays(base.date, x);
    if (dueAt > today) return null;
    const reason = base.removed
      ? `最後の枯葉処理（${formatMonthDay(base.date)}）から ${x} 日`
      : `採用・植え付け（${formatMonthDay(base.date)}）から ${x} 日。枯葉処理の記録がありません`;
    return { ruleKey: base.key, dueAt, reason };
  },
  completion(stem, ruleKey) {
    const removedKey = ruleKey.startsWith(DEAD_LEAVES_REMOVED);
    const baseDate = ruleKey.slice(removedKey ? DEAD_LEAVES_REMOVED.length : DEAD_LEAVES_START.length);
    const after = stem.events
      .filter((e) => e.type === "leaves_removed" && (removedKey ? e.date > baseDate : e.date >= baseDate))
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    return after ? doneBy(after, "枯葉処理を記録") : null;
  },
};

// --- 3-5 確認（重い被害） ----------------------------------------------------------------------------------
// 栽培中・出蕾済みの茎の、最新の茎の被害（damage）が severe。期限は今日（作った日）。rule_key は「damage:イベント id」。
// done: その被害の記録を訂正した（訂正した行の記録者）、またはその後に茎の被害（喪失以外）を記録し直した（確認の結果を事実で残す）。
// 喪失（lost）は茎が終了するので「対象が終了」で閉じる（喪失には確認を出さない）
const INSPECT_DAMAGE = "damage:";

const inspectDamageRule: StemRule = {
  kind: "inspect",
  targetType: "stem",
  owns: (key) => key.startsWith(INSPECT_DAMAGE),
  propose(stem, today) {
    if (!GROWING_STATUSES.includes(stem.status)) return null;
    const last = latestEvent(stem, "damage");
    if (!last || last.severity !== "severe") return null;
    const kind = damageKindLabel(last.damageKind);
    return {
      ruleKey: `${INSPECT_DAMAGE}${last.id}`,
      dueAt: today,
      reason: `重い被害（${kind ? `${kind}・` : ""}重、${formatMonthDay(last.date)}）を確認してください`,
    };
  },
  completion(stem, ruleKey) {
    const id = ruleKey.slice(INSPECT_DAMAGE.length);
    const original = stem.events.find((e) => e.id === id);
    if (!original) {
      const by = stem.replacedBy?.[id];
      return by ? { note: "被害の記録を訂正", recordedBy: by.recordedBy, eventId: by.id } : null;
    }
    const later = stem.events
      .filter((e) => e.type === "damage" && e.severity !== "lost" && e.id !== id && e.date >= original.date)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    return later ? doneBy(later, "被害を記録し直した") : null;
  },
};

// --- 3-5 確認（累計葉数の検算ずれ） ------------------------------------------------------------------------
// 栽培中・出蕾済みの茎で、1-6 の検算（累計 = 初期葉数 + Σ新葉、検算 = 最新の現在の葉数 + それまでの枯葉処理）の差が 3 枚以上。
// 茎の画面の警告「確認してください（累計 X、検算 Y）」と同じ式（src/lib/leaves.ts）。期限は今日。rule_key は「leaf_check:観測 id」
// （検算に使った最新の現在の葉数）。
// done: 現在の葉数を記録し直した（新しい検算。まだずれていれば新しい観測で次の提案になる）、その観測を訂正した、
// または新葉・初期葉数の訂正などでずれが 3 枚未満になった
const INSPECT_LEAF = "leaf_check:";

function leafCheck(stem: StemFacts): { cumulative: number; byCheck: number; latest: LeafObservationFact } | null {
  if (stem.initialLeafCount === null || stem.initialLeafCount === undefined) return null;
  const current = stem.leavesCurrent ?? [];
  if (current.length === 0) return null;
  const latest = [...current].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || b.id.localeCompare(a.id))[0];
  const removed = stem.events
    .filter((e) => e.type === "leaves_removed" && typeof e.count === "number" && Number.isFinite(e.count) && e.occurredAt)
    .map((e) => ({ count: e.count as number, occurredAt: new Date(e.occurredAt as string) }));
  const byCheck = cumulativeLeavesByCheck(
    current.map((o) => ({ type: "leaves_current" as const, value: o.value, observedAt: new Date(o.observedAt) })),
    removed,
  );
  if (byCheck === null) return null;
  return { cumulative: stem.initialLeafCount + (stem.leavesNewSum ?? 0), byCheck, latest };
}

const inspectLeafRule: StemRule = {
  kind: "inspect",
  targetType: "stem",
  owns: (key) => key.startsWith(INSPECT_LEAF),
  propose(stem, today) {
    if (!GROWING_STATUSES.includes(stem.status)) return null;
    const check = leafCheck(stem);
    if (!check) return null;
    const diff = Math.abs(check.cumulative - check.byCheck);
    if (diff < LEAF_CHECK_THRESHOLD) return null;
    return {
      ruleKey: `${INSPECT_LEAF}${check.latest.id}`,
      dueAt: today,
      reason: `累計葉数の検算が ${diff} 枚ずれています（累計 ${check.cumulative}、検算 ${check.byCheck}）`,
    };
  },
  completion(stem, ruleKey) {
    const id = ruleKey.slice(INSPECT_LEAF.length);
    const corrected = stem.replacedBy?.[id];
    if (corrected) return { note: "葉数の記録を訂正", recordedBy: corrected.recordedBy, eventId: null };
    const check = leafCheck(stem);
    if (check && check.latest.id !== id) return { note: "現在の葉数を記録", recordedBy: check.latest.observedBy, eventId: null };
    if (!check || Math.abs(check.cumulative - check.byCheck) < LEAF_CHECK_THRESHOLD) {
      return { note: "検算のずれが解消", recordedBy: null, eventId: null };
    }
    return null;
  },
};

export const STEM_RULES: readonly StemRule[] = [
  budAfterRule("bag", "bagged", "袋掛けを記録"),
  budAfterRule("debud", "debudded", "摘蕾を記録"),
  harvestWindowRule,
  deadLeavesRule,
  inspectDamageRule,
  inspectLeafRule,
];

// --- 3-5 収穫後の追肥（株が対象） ---------------------------------------------------------------------------
// 撤去していない株で、最後の収穫の日（その株の茎の収穫日の最大）以降に施肥（fertilized、2-4 の一括入力を含む）がない。
// 収穫を記録したらすぐ出す。期限は収穫日 + M（M 日以内の施肥を促す）。rule_key は「harvest:収穫日」（同じ株・同じ日の収穫は 1 件）。
// done: 収穫日以降（同じ日を含む）の施肥。量は理由に入れず、一覧で今の圃場の標準量を出す（設定を後から変えても追従する）
const FERTILIZE_HARVEST = "harvest:";

export const fertilizeAfterHarvestRule: MatRule = {
  kind: "fertilize_after_harvest",
  targetType: "mat",
  propose(mat) {
    if (mat.status !== "active" || mat.harvestDates.length === 0) return null;
    const harvest = [...mat.harvestDates].sort().at(-1) as string;
    if (mat.fertilizations.some((f) => f.date >= harvest)) return null;
    const m = mat.settings.fertilizeAfterHarvestDays;
    return {
      ruleKey: `${FERTILIZE_HARVEST}${harvest}`,
      dueAt: addDays(harvest, m),
      reason: `収穫（${formatMonthDay(harvest)}）から ${m} 日以内に追肥`,
    };
  },
  completion(mat, ruleKey) {
    const harvest = ruleKey.slice(FERTILIZE_HARVEST.length);
    const f = mat.fertilizations.filter((x) => x.date >= harvest).sort((a, b) => a.date.localeCompare(b.date))[0];
    return f ? { note: "施肥を記録", recordedBy: f.recordedBy, eventId: f.id } : null;
  },
};

export const MAT_RULES: readonly MatRule[] = [fertilizeAfterHarvestRule];

// 茎を終了させたイベント（「対象が終了」で閉じるときの根拠。見つからなければ null）
export function endingEvent(stem: StemFacts): StemEventFact | null {
  const candidates = stem.events.filter((e) => e.type === "harvested" || (e.type === "damage" && e.severity === "lost"));
  return candidates.sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}
