// 提案の評価（3-4・3-5、prediction.md 6 章）: 対象の事実と既存の提案から「作るべき提案」「閉じるべき提案」を決める。純粋関数。
//
// - 同じ対象・同じ kind で open があれば作らない（確認 inspect は 2 つのルール（重い被害・検算ずれ）で出すが、open は 1 件まで）
// - 同じ対象・同じ kind・同じ rule_key の提案が（状態に関係なく）あれば作らない →「無視」（dismissed）した提案は再び作られない
//   （DB でも unique (target_type, target_id, kind, rule_key) と open の部分 unique で防ぐ。0022）
// - open の提案は、対応する記録（ルールの completion）があれば done（その記録の記録者を resolved_by に）
// - 対応する記録がなく対象が終了（茎: lost / harvested / removed / transplanted、株: 撤去）していれば dismissed（「対象が終了」）
import {
  type Completion,
  ENDED_NOTE,
  ENDED_STEM_STATUSES,
  endingEvent,
  MAT_RULES,
  type MatFacts,
  type MatRule,
  type RecommendationKind,
  type Rule,
  STEM_RULES,
  type StemFacts,
  type StemRule,
} from "./rules";

export type TargetType = "stem" | "mat";

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
  targetType: TargetType;
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

type Target<F> = {
  id: string;
  facts: F;
  // 対象が終了していれば、その原因（記録者・イベント。見つからなければ null の Completion）
  ended: Pick<Completion, "recordedBy" | "eventId"> | null;
};

function evaluateTargets<F>(
  targetType: TargetType,
  targets: readonly Target<F>[],
  rules: readonly Rule<F>[],
  existing: readonly ExistingRecommendation[],
  today: string,
): EvaluationResult {
  const create: NewRecommendation[] = [];
  const resolve: Resolution[] = [];
  const byTarget = new Map<string, ExistingRecommendation[]>();
  for (const r of existing) {
    if (r.targetType !== targetType) continue;
    const list = byTarget.get(r.targetId);
    if (list) list.push(r);
    else byTarget.set(r.targetId, [r]);
  }

  for (const target of targets) {
    const recs = byTarget.get(target.id) ?? [];
    const closed = new Set<string>(); // この評価で閉じる提案
    const created = new Set<string>(); // この評価で作る kind
    for (const rule of rules) {
      const sameKind = recs.filter((r) => r.kind === rule.kind);
      const own = sameKind.filter((r) => rule.owns?.(r.ruleKey) ?? true);
      for (const r of own) {
        if (r.status !== "open" || closed.has(r.id)) continue;
        const done = rule.completion(target.facts, r.ruleKey);
        if (done) {
          resolve.push({ id: r.id, status: "done", note: done.note, resolvedBy: done.recordedBy, eventId: done.eventId });
          closed.add(r.id);
        } else if (target.ended) {
          resolve.push({ id: r.id, status: "dismissed", note: ENDED_NOTE, resolvedBy: target.ended.recordedBy, eventId: target.ended.eventId });
          closed.add(r.id);
        }
      }
      if (target.ended) continue;
      if (sameKind.some((r) => r.status === "open" && !closed.has(r.id))) continue; // まだ対応していない提案がある
      if (created.has(rule.kind)) continue; // 同じ kind を別のルールで作った（open は 1 件まで）
      const draft = rule.propose(target.facts, today);
      if (!draft) continue;
      if (sameKind.some((r) => r.ruleKey === draft.ruleKey)) continue; // 同じ鍵の提案がある（done / dismissed を含む）
      create.push({ kind: rule.kind, targetType, targetId: target.id, ...draft });
      created.add(rule.kind);
    }
  }
  return { create, resolve };
}

export function evaluateStemRecommendations(
  stems: readonly StemFacts[],
  existing: readonly ExistingRecommendation[],
  today: string,
  rules: readonly StemRule[] = STEM_RULES,
): EvaluationResult {
  const targets = stems.map((s) => {
    const cause = ENDED_STEM_STATUSES.includes(s.status) ? endingEvent(s) : undefined;
    return {
      id: s.stemId,
      facts: s,
      ended: cause === undefined ? null : { recordedBy: cause?.recordedBy ?? null, eventId: cause?.id ?? null },
    };
  });
  return evaluateTargets("stem", targets, rules, existing, today);
}

// 株が対象の提案（3-5 収穫後の追肥）。撤去した株の open は「対象が終了」（撤去のイベント）
export function evaluateMatRecommendations(
  mats: readonly MatFacts[],
  existing: readonly ExistingRecommendation[],
  today: string,
  rules: readonly MatRule[] = MAT_RULES,
): EvaluationResult {
  const targets = mats.map((m) => ({
    id: m.matId,
    facts: m,
    ended: m.status === "removed" ? { recordedBy: m.removal?.recordedBy ?? null, eventId: m.removal?.id ?? null } : null,
  }));
  return evaluateTargets("mat", targets, rules, existing, today);
}
