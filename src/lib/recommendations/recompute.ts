// 提案の評価を DB に反映する（3-4、prediction.md 6 章）。ルール・判定は rules.ts / evaluate.ts（純粋関数）。
// 収穫予測日の再計算（src/lib/prediction/recompute.ts）と同じ入口で、その後に走る（src/lib/derived.ts）:
// 茎のイベントの同期後（POST /api/predictions/recompute）、日次の Cron と「今すぐ取り込む」の後、予測・提案の設定の保存後、
// 訂正後、圃場・株の被害の記録後、推定の無い出蕾済みの茎を開いたとき。
// DB のクライアントは呼び出し側が渡す（Cron は service_role、それ以外はログイン中のユーザー = RLS で自組織だけ）。
//
// - 対象の茎: 範囲（茎 / 圃場 / 株）の出蕾済みの茎と、範囲の中で open の提案がある茎（終了した茎の提案を閉じるため）。
//   茎の id で呼ばれたときは状態に関係なくその茎
// - 追記は on conflict do nothing（unique (target_type, target_id, kind, rule_key)、0022）。open の二重（部分 unique）に
//   当たったら 1 行ずつ入れ直して重なった行だけ飛ばす（再計算が同時に走ったとき）
// - 閉じるのは status = 'open' の行だけを更新する（同時に閉じられていたら何もしない）。organization_id は渡さない
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecomputeScope } from "../prediction/recompute";
import { jstDateOf } from "../weather/dates";
import { evaluateStemRecommendations, type ExistingRecommendation, type NewRecommendation } from "./evaluate";
import type { StemEventFact, StemFacts } from "./rules";
import { resolveRecommendationSettings } from "./settings";

const PAGE = 1000;
const ID_CHUNK = 100;

export type RecommendationResult = {
  stems: number;
  created: number;
  resolved: number;
  errors: string[];
};

type StemRow = {
  id: string;
  status: string;
  bud_emerged_at: string | null;
  mat_id: string;
  mats: { field_id: string; cultivar_id: string };
};

type Page<T> = { data: T[] | null; error: { message: string; code?: string } | null };

function chunks<T>(list: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function selectAll<T>(build: (from: number, to: number) => PromiseLike<Page<T>>, label: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(`${label}を読めません（${error.message}）`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const STEM_COLUMNS = "id, status, bud_emerged_at, mat_id, mats!stems_mat_id_fkey!inner ( field_id, cultivar_id )";

async function loadStemsByIds(db: SupabaseClient, ids: readonly string[]): Promise<StemRow[]> {
  const out: StemRow[] = [];
  for (const chunk of chunks([...new Set(ids)])) {
    const { data, error } = await db.from("stems").select(STEM_COLUMNS).in("id", chunk);
    if (error) throw new Error(`茎を読めません（${error.message}）`);
    out.push(...((data ?? []) as unknown as StemRow[]));
  }
  return out;
}

function inScope(s: StemRow, scope: RecomputeScope): boolean {
  if ("stemIds" in scope) return true;
  if ("fieldId" in scope) {
    if (s.mats.field_id !== scope.fieldId) return false;
    if (scope.cultivarId && s.mats.cultivar_id !== scope.cultivarId) return false;
  }
  if (scope.matId && s.mat_id !== scope.matId) return false;
  return true;
}

async function loadTargetStems(db: SupabaseClient, scope: RecomputeScope): Promise<StemRow[]> {
  if ("stemIds" in scope) return loadStemsByIds(db, scope.stemIds);
  const flowered = await selectAll<StemRow>((from, to) => {
    let q = db.from("stems").select(STEM_COLUMNS).eq("status", "flowered");
    if ("fieldId" in scope) {
      q = q.eq("mats.field_id", scope.fieldId);
      if (scope.cultivarId) q = q.eq("mats.cultivar_id", scope.cultivarId);
    }
    if (scope.matId) q = q.eq("mat_id", scope.matId);
    return q.order("id").range(from, to) as unknown as PromiseLike<Page<StemRow>>;
  }, "茎");
  // open の提案がある茎（終了した茎の提案を閉じる）。open は少ない前提で全件を読み、範囲で絞る
  const open = await selectAll<{ target_id: string }>(
    (from, to) =>
      db
        .from("recommendations")
        .select("target_id")
        .eq("status", "open")
        .eq("target_type", "stem")
        .order("id")
        .range(from, to) as unknown as PromiseLike<Page<{ target_id: string }>>,
    "提案",
  );
  const known = new Set(flowered.map((s) => s.id));
  const others = [...new Set(open.map((r) => r.target_id))].filter((id) => !known.has(id));
  const extra = (await loadStemsByIds(db, others)).filter((s) => inScope(s, scope));
  return [...flowered, ...extra];
}

type EventRow = { id: string; type: string; target_id: string; occurred_at: string; recorded_by: string | null; payload: Record<string, unknown> | null };

async function loadEvents(db: SupabaseClient, stemIds: readonly string[]): Promise<EventRow[]> {
  const out: EventRow[] = [];
  for (const chunk of chunks(stemIds)) {
    const rows = await selectAll<EventRow>(
      (from, to) =>
        db
          .from("events")
          .select("id, type, target_id, occurred_at, recorded_by, payload")
          .eq("target_type", "stem")
          .in("target_id", chunk)
          .in("type", ["bagged", "debudded", "harvested", "damage"])
          .is("superseded_by", null)
          .order("id")
          .range(from, to) as unknown as PromiseLike<Page<EventRow>>,
      "イベント",
    );
    out.push(...rows);
  }
  return out;
}

async function insertRecommendations(db: SupabaseClient, rows: NewRecommendation[]): Promise<number> {
  if (rows.length === 0) return 0;
  const toRow = (r: NewRecommendation) => ({
    kind: r.kind,
    target_type: r.targetType,
    target_id: r.targetId,
    rule_key: r.ruleKey,
    due_at: r.dueAt,
    reason: r.reason,
  });
  const upsert = (list: NewRecommendation[]) =>
    db
      .from("recommendations")
      .upsert(list.map(toRow), { onConflict: "target_type,target_id,kind,rule_key", ignoreDuplicates: true })
      .select("id");
  const { data, error } = await upsert(rows);
  if (!error) return (data ?? []).length;
  if (error.code !== "23505") throw new Error(`提案を保存できません（${error.message}）`);
  // open の二重（recommendations_one_open）に当たった: 1 行ずつ入れて、重なった行だけ飛ばす
  let n = 0;
  for (const r of rows) {
    const one = await upsert([r]);
    if (one.error && one.error.code !== "23505") throw new Error(`提案を保存できません（${one.error.message}）`);
    n += (one.data ?? []).length;
  }
  return n;
}

export async function recomputeRecommendations(
  db: SupabaseClient,
  scope: RecomputeScope,
  options: { now?: Date } = {},
): Promise<RecommendationResult> {
  const today = jstDateOf(options.now ?? new Date());
  const result: RecommendationResult = { stems: 0, created: 0, resolved: 0, errors: [] };
  try {
    const stems = await loadTargetStems(db, scope);
    result.stems = stems.length;
    if (stems.length === 0) return result;
    const stemIds = stems.map((s) => s.id);
    const fieldIds = [...new Set(stems.map((s) => s.mats.field_id))];

    const [events, estimates, existing, params] = await Promise.all([
      loadEvents(db, stemIds),
      (async () => {
        const out: { stem_id: string; lower_date: string | null }[] = [];
        for (const chunk of chunks(stemIds)) {
          const { data, error } = await db.from("latest_estimates").select("stem_id, lower_date").eq("kind", "harvest_date").in("stem_id", chunk);
          if (error) throw new Error(`推定を読めません（${error.message}）`);
          out.push(...((data ?? []) as typeof out));
        }
        return out;
      })(),
      (async () => {
        const out: ExistingRecommendation[] = [];
        for (const chunk of chunks(stemIds)) {
          const { data, error } = await db
            .from("recommendations")
            .select("id, kind, target_type, target_id, rule_key, status")
            .eq("target_type", "stem")
            .in("target_id", chunk);
          if (error) throw new Error(`提案を読めません（${error.message}）`);
          for (const r of data ?? [])
            out.push({ id: r.id, kind: r.kind, targetType: r.target_type, targetId: r.target_id, ruleKey: r.rule_key, status: r.status });
        }
        return out;
      })(),
      db.from("field_recommendation_params").select("field_id, bag_after_days, harvest_window_days").in("field_id", fieldIds),
    ]);
    if (params.error) throw new Error(`提案の設定を読めません（${params.error.message}）`);

    const settingsByField = new Map((params.data ?? []).map((p) => [p.field_id as string, resolveRecommendationSettings(p)]));
    const lowerByStem = new Map(estimates.map((e) => [e.stem_id, e.lower_date]));
    const eventsByStem = new Map<string, StemEventFact[]>();
    for (const e of events) {
      const fact: StemEventFact = {
        id: e.id,
        type: e.type,
        date: jstDateOf(e.occurred_at),
        recordedBy: e.recorded_by,
        severity: typeof e.payload?.severity === "string" ? e.payload.severity : null,
      };
      const list = eventsByStem.get(e.target_id);
      if (list) list.push(fact);
      else eventsByStem.set(e.target_id, [fact]);
    }
    const facts: StemFacts[] = stems.map((s) => ({
      stemId: s.id,
      status: s.status,
      budEmergedAt: s.bud_emerged_at,
      events: eventsByStem.get(s.id) ?? [],
      harvestLowerDate: lowerByStem.get(s.id) ?? null,
      settings: settingsByField.get(s.mats.field_id) ?? resolveRecommendationSettings(null),
    }));

    const { create, resolve } = evaluateStemRecommendations(facts, existing, today);

    for (const r of resolve) {
      const { data, error } = await db
        .from("recommendations")
        .update({ status: r.status, resolution_note: r.note, resolved_by: r.resolvedBy, resolved_event_id: r.eventId })
        .eq("id", r.id)
        .eq("status", "open")
        .select("id");
      if (error) throw new Error(`提案を閉じられません（${error.message}）`);
      result.resolved += (data ?? []).length;
    }
    result.created += await insertRecommendations(db, create);
  } catch (e) {
    result.errors.push((e as Error).message);
  }
  return result;
}
