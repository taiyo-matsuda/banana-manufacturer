// 提案の評価（3-4、prediction.md 6 章）: 対象の事実と既存の提案から「作るべき提案」「閉じるべき提案」を決める。純粋関数。
//
// - 同じ対象・同じ kind で open があれば作らない
// - 同じ対象・同じ kind・同じ rule_key の提案が（状態に関係なく）あれば作らない →「無視」（dismissed）した提案は再び作られない
//   （DB でも unique (target_type, target_id, kind, rule_key) と open の部分 unique で防ぐ。0022）
// - open の提案は、対応する記録（ルールの completion）があれば done（そのイベントの記録者を resolved_by に）
// - 対応する記録がなく対象の茎が終了（lost / harvested / removed / transplanted）していれば dismissed（「対象が終了」）
import { ENDED_NOTE, ENDED_STEM_STATUSES, endingEvent, type RecommendationKind, STEM_RULES, type StemFacts, type StemRule } from "./rules";

export type ExistingRecommendation = {
  id: string;
  kind: string;
  targetType: string;
  targetId: string;
  ruleKey: string;
  status: string; // open / done / dismissed
};

export type NewRecommendation = {
  kind: RecommendationKind;
  targetType: "stem";
  targetId: string;
  ruleKey: string;
  dueAt: string;
  reason: string;
};

export type Resolution = {
  id: string;
  status: "done" | "dismissed";
  note: string;
  resolvedBy: string | null;
  eventId: string | null;
};

export type EvaluationResult = { create: NewRecommendation[]; resolve: Resolution[] };

const EVENT_NOTES: Record<string, string> = {
  bagged: "袋掛けを記録",
  debudded: "摘蕾を記録",
  harvested: "収穫を記録",
};

export function evaluateStemRecommendations(
  stems: readonly StemFacts[],
  existing: readonly ExistingRecommendation[],
  today: string,
  rules: readonly StemRule[] = STEM_RULES,
): EvaluationResult {
  const create: NewRecommendation[] = [];
  const resolve: Resolution[] = [];
  const byTarget = new Map<string, ExistingRecommendation[]>();
  for (const r of existing) {
    if (r.targetType !== "stem") continue;
    const list = byTarget.get(r.targetId);
    if (list) list.push(r);
    else byTarget.set(r.targetId, [r]);
  }

  for (const stem of stems) {
    const recs = byTarget.get(stem.stemId) ?? [];
    const ended = ENDED_STEM_STATUSES.includes(stem.status);
    for (const rule of rules) {
      const mine = recs.filter((r) => r.kind === rule.kind);
      let open = mine.filter((r) => r.status === "open");
      if (open.length > 0) {
        const done = rule.completion(stem);
        if (done) {
          for (const r of open)
            resolve.push({ id: r.id, status: "done", note: EVENT_NOTES[done.type] ?? done.type, resolvedBy: done.recordedBy, eventId: done.id });
          open = [];
        } else if (ended) {
          const cause = endingEvent(stem);
          for (const r of open)
            resolve.push({ id: r.id, status: "dismissed", note: ENDED_NOTE, resolvedBy: cause?.recordedBy ?? null, eventId: cause?.id ?? null });
          open = [];
        }
      }
      if (open.length > 0) continue; // まだ対応していない提案がある
      const draft = rule.propose(stem, today);
      if (!draft) continue;
      if (mine.some((r) => r.ruleKey === draft.ruleKey)) continue; // 同じ鍵の提案がある（done / dismissed を含む）
      create.push({ kind: rule.kind, targetType: "stem", targetId: stem.stemId, ...draft });
    }
  }
  return { create, resolve };
}
