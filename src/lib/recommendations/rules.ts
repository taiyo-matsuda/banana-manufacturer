// 提案のルール（3-4、prediction.md 6 章）。UI・DB に依存しない純粋関数。
//
// ルールは RULES の配列に並べる（3-5 の追肥・枯葉処理・確認はここに足す）。1 つのルールは:
// - propose: 対象の事実（茎・イベント・推定）と設定・今日から「いま出すべき提案」を返す（出さないなら null）
// - completion: open の提案を done にするイベント（対応する記録）を返す（なければ null）
// 評価（evaluate.ts）が、既存の提案（全状態）と突き合わせて「作るもの」「閉じるもの」を決める。
import { addDays } from "../weather/dates";
import { formatMonthDay } from "../prediction/harvest";
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
export const ENDED_NOTE = "対象が終了";
export const DISMISSED_NOTE = "無視";

// 茎のイベント（訂正済み superseded_by を除いた現在のもの）
export type StemEventFact = {
  id: string;
  type: string;
  date: string; // 日本時間の日付
  recordedBy: string | null;
  severity?: string | null; // damage のとき
};

export type StemFacts = {
  stemId: string;
  status: string;
  budEmergedAt: string | null; // 出蕾の確認日
  events: readonly StemEventFact[];
  // 収穫予測日（latest_estimates の harvest_date）の下限。推定が無い・予測できなかったなら null
  harvestLowerDate: string | null;
  settings: RecommendationSettings;
};

export type ProposalDraft = { ruleKey: string; dueAt: string; reason: string };

export type StemRule = {
  kind: RecommendationKind;
  targetType: "stem";
  propose: (stem: StemFacts, today: string) => ProposalDraft | null;
  completion: (stem: StemFacts) => StemEventFact | null;
};

function latestEvent(stem: StemFacts, type: string): StemEventFact | null {
  let found: StemEventFact | null = null;
  for (const e of stem.events) if (e.type === type && (!found || e.date >= found.date)) found = e;
  return found;
}

// 袋掛け・摘蕾: 出蕾から N 日たって、その記録（bagged / debudded）がない出蕾済みの茎。期限は出蕾日 + N
function budAfterRule(kind: "bag" | "debud", eventType: "bagged" | "debudded"): StemRule {
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
    completion: (stem) => latestEvent(stem, eventType),
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
  completion: (stem) => latestEvent(stem, "harvested"),
};

export const STEM_RULES: readonly StemRule[] = [
  budAfterRule("bag", "bagged"),
  budAfterRule("debud", "debudded"),
  harvestWindowRule,
];

// 茎を終了させたイベント（「対象が終了」で閉じるときの根拠。見つからなければ null）
export function endingEvent(stem: StemFacts): StemEventFact | null {
  const candidates = stem.events.filter((e) => e.type === "harvested" || (e.type === "damage" && e.severity === "lost"));
  return candidates.sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
}
