// 提案の評価を DB に反映する（3-4・3-5、prediction.md 6 章）。ルール・判定は rules.ts / evaluate.ts（純粋関数）。
// 収穫予測日の再計算（src/lib/prediction/recompute.ts）と同じ入口で、その後に走る（src/lib/derived.ts）:
// 茎のイベント・葉数の観測の同期後（POST /api/predictions/recompute）、日次の Cron と「今すぐ取り込む」の後、予測・提案の設定の保存後、
// 訂正後、圃場・株の被害の記録後、施肥の一括入力の後、株の撤去の後、推定の無い出蕾済みの茎を開いたとき。
// DB のクライアントは呼び出し側が渡す（Cron は service_role、それ以外はログイン中のユーザー = RLS で自組織だけ）。
//
// - 対象の茎: 範囲（茎 / 圃場 / 株）の栽培中・出蕾済みの茎と、範囲の中で open の提案がある茎（終了した茎の提案を閉じるため）。
//   茎の id で呼ばれたときは状態に関係なくその茎
// - 対象の株（3-5 収穫後の追肥）: 茎の id のときはその茎の株、圃場・株の範囲ではその中の株（撤去済みを含む。open を閉じるため）
// - 追記は on conflict do nothing（unique (target_type, target_id, kind, rule_key)、0022）。open の二重（部分 unique）に
//   当たったら 1 行ずつ入れ直して重なった行だけ飛ばす（再計算が同時に走ったとき）
// - 閉じるのは status = 'open' の行だけを更新する（同時に閉じられていたら何もしない）。organization_id は渡さない
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RecomputeScope } from "../prediction/recompute";
import { jstDateOf } from "../weather/dates";
import {
  evaluateMatRecommendations,
  evaluateStemRecommendations,
  type ExistingRecommendation,
  type NewRecommendation,
  type Resolution,
} from "./evaluate";
import type { LeafNewFact, LeafObservationFact, MatFacts, Replacement, StemEventFact, StemFacts } from "./rules";
import { RECOMMENDATION_PARAMS_COLUMNS, type RecommendationParamsRow, resolveRecommendationSettings } from "./settings";

const PAGE = 1000;
const ID_CHUNK = 100;

export type RecommendationResult = {
  stems: number;
  mats: number;
  created: number;
  resolved: number;
  errors: string[];
};

type StemRow = {
  id: string;
  status: string;
  bud_emerged_at: string | null;
  started_at: string | null;
  adopted_at: string | null;
  initial_leaf_count: number | null;
  mat_id: string;
  mats: { field_id: string; cultivar_id: string };
};

type MatRow = { id: string; status: string; field_id: string };

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

// id の一覧を 100 件ずつに分けて、ページ送りで全部読む
async function selectByIds<T>(
  ids: readonly string[],
  build: (chunk: string[], from: number, to: number) => PromiseLike<Page<T>>,
  label: string,
): Promise<T[]> {
  const out: T[] = [];
  for (const chunk of chunks([...new Set(ids)])) out.push(...(await selectAll<T>((from, to) => build(chunk, from, to), label)));
  return out;
}

const STEM_COLUMNS =
  "id, status, bud_emerged_at, started_at, adopted_at, initial_leaf_count, mat_id, mats!stems_mat_id_fkey!inner ( field_id, cultivar_id )";

async function loadStemsByIds(db: SupabaseClient, ids: readonly string[]): Promise<StemRow[]> {
  return selectByIds<StemRow>(
    ids,
    (chunk, from, to) => db.from("stems").select(STEM_COLUMNS).in("id", chunk).order("id").range(from, to) as unknown as PromiseLike<Page<StemRow>>,
    "茎",
  );
}

function inScope(s: { mat_id: string; field_id: string; cultivar_id?: string }, scope: RecomputeScope): boolean {
  if ("stemIds" in scope) return true;
  if ("fieldId" in scope) {
    if (s.field_id !== scope.fieldId) return false;
    if (scope.cultivarId && s.cultivar_id !== scope.cultivarId) return false;
  }
  if (scope.matId && s.mat_id !== scope.matId) return false;
  return true;
}

async function openTargets(db: SupabaseClient, targetType: "stem" | "mat"): Promise<string[]> {
  // open の提案がある対象（終了した対象の提案を閉じる）。open は少ない前提で全件を読み、範囲で絞る
  const rows = await selectAll<{ target_id: string }>(
    (from, to) =>
      db
        .from("recommendations")
        .select("target_id")
        .eq("status", "open")
        .eq("target_type", targetType)
        .order("id")
        .range(from, to) as unknown as PromiseLike<Page<{ target_id: string }>>,
    "提案",
  );
  return [...new Set(rows.map((r) => r.target_id))];
}

async function loadTargetStems(db: SupabaseClient, scope: RecomputeScope): Promise<StemRow[]> {
  if ("stemIds" in scope) return loadStemsByIds(db, scope.stemIds);
  const growing = await selectAll<StemRow>((from, to) => {
    let q = db.from("stems").select(STEM_COLUMNS).in("status", ["active", "flowered"]);
    if ("fieldId" in scope) {
      q = q.eq("mats.field_id", scope.fieldId);
      if (scope.cultivarId) q = q.eq("mats.cultivar_id", scope.cultivarId);
    }
    if (scope.matId) q = q.eq("mat_id", scope.matId);
    return q.order("id").range(from, to) as unknown as PromiseLike<Page<StemRow>>;
  }, "茎");
  const known = new Set(growing.map((s) => s.id));
  const others = (await openTargets(db, "stem")).filter((id) => !known.has(id));
  const extra = (await loadStemsByIds(db, others)).filter((s) => inScope({ mat_id: s.mat_id, ...s.mats }, scope));
  return [...growing, ...extra];
}

async function loadTargetMats(db: SupabaseClient, scope: RecomputeScope, stems: readonly StemRow[]): Promise<MatRow[]> {
  const columns = "id, status, field_id";
  if ("stemIds" in scope) {
    return selectByIds<MatRow>(
      stems.map((s) => s.mat_id),
      (chunk, from, to) => db.from("mats").select(columns).in("id", chunk).order("id").range(from, to) as unknown as PromiseLike<Page<MatRow>>,
      "株",
    );
  }
  return selectAll<MatRow>((from, to) => {
    let q = db.from("mats").select(columns);
    if ("fieldId" in scope) {
      q = q.eq("field_id", scope.fieldId);
      if (scope.cultivarId) q = q.eq("cultivar_id", scope.cultivarId);
    }
    if (scope.matId) q = q.eq("id", scope.matId);
    return q.order("id").range(from, to) as unknown as PromiseLike<Page<MatRow>>;
  }, "株");
}

type EventRow = {
  id: string;
  type: string;
  target_id: string;
  occurred_at: string;
  recorded_by: string | null;
  payload: Record<string, unknown> | null;
  superseded_by: string | null;
};

const EVENT_COLUMNS = "id, type, target_id, occurred_at, recorded_by, payload, superseded_by";
const STEM_EVENT_TYPES = ["bagged", "debudded", "harvested", "damage", "leaves_removed"];

type ObservationRow = { id: string; stem_id: string; type: string; value: number | string; observed_at: string; observed_by: string | null; superseded_by: string | null };

async function loadExisting(db: SupabaseClient, targetType: "stem" | "mat", ids: readonly string[]): Promise<ExistingRecommendation[]> {
  const rows = await selectByIds<{ id: string; kind: string; target_type: string; target_id: string; rule_key: string; status: string }>(
    ids,
    (chunk, from, to) =>
      db
        .from("recommendations")
        .select("id, kind, target_type, target_id, rule_key, status")
        .eq("target_type", targetType)
        .in("target_id", chunk)
        .order("id")
        .range(from, to) as unknown as PromiseLike<Page<{ id: string; kind: string; target_type: string; target_id: string; rule_key: string; status: string }>>,
    "提案",
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, targetType: r.target_type, targetId: r.target_id, ruleKey: r.rule_key, status: r.status }));
}

// 訂正の鎖を辿って、いまの行（訂正した最後の行）を返す
function replacementOf(id: string, supersededBy: ReadonlyMap<string, string>, recorder: ReadonlyMap<string, string | null>): Replacement | null {
  let cur = supersededBy.get(id);
  if (!cur) return null;
  const seen = new Set<string>([id]);
  while (supersededBy.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = supersededBy.get(cur) as string;
  }
  return { id: cur, recordedBy: recorder.get(cur) ?? null };
}

async function buildStemFacts(db: SupabaseClient, stems: readonly StemRow[], settingsByField: Map<string, ReturnType<typeof resolveRecommendationSettings>>): Promise<StemFacts[]> {
  const stemIds = stems.map((s) => s.id);
  const [events, estimates, observations] = await Promise.all([
    selectByIds<EventRow>(
      stemIds,
      (chunk, from, to) =>
        db
          .from("events")
          .select(EVENT_COLUMNS)
          .eq("target_type", "stem")
          .in("target_id", chunk)
          .in("type", STEM_EVENT_TYPES)
          .order("id")
          .range(from, to) as unknown as PromiseLike<Page<EventRow>>,
      "イベント",
    ),
    selectByIds<{ stem_id: string; lower_date: string | null }>(
      stemIds,
      (chunk, from, to) =>
        db
          .from("latest_estimates")
          .select("stem_id, lower_date")
          .eq("kind", "harvest_date")
          .in("stem_id", chunk)
          .order("stem_id")
          .range(from, to) as unknown as PromiseLike<Page<{ stem_id: string; lower_date: string | null }>>,
      "推定",
    ),
    // 検算に使う「現在の葉数」と「新葉」（3-5a: 現在の葉数を記録した時点以前の新葉だけを数えるので、新葉も観測ごとに読む）。
    // 訂正された行も読む（現在の葉数の訂正で確認を閉じるため。検算には現在の値だけを使う）
    selectByIds<ObservationRow>(
      stemIds,
      (chunk, from, to) =>
        db
          .from("observations")
          .select("id, stem_id, type, value, observed_at, observed_by, superseded_by")
          .in("type", ["leaves_current", "leaves_new"])
          .in("stem_id", chunk)
          .order("id")
          .range(from, to) as unknown as PromiseLike<Page<ObservationRow>>,
      "観測",
    ),
  ]);

  const lowerByStem = new Map(estimates.map((e) => [e.stem_id, e.lower_date]));
  const supersededBy = new Map<string, string>();
  const recorder = new Map<string, string | null>();
  for (const e of events) {
    recorder.set(e.id, e.recorded_by);
    if (e.superseded_by) supersededBy.set(e.id, e.superseded_by);
  }
  for (const o of observations) {
    recorder.set(o.id, o.observed_by);
    if (o.superseded_by) supersededBy.set(o.id, o.superseded_by);
  }

  const eventsByStem = new Map<string, StemEventFact[]>();
  const replacedByStem = new Map<string, Record<string, Replacement>>();
  const addReplacement = (stemId: string, id: string) => {
    const r = replacementOf(id, supersededBy, recorder);
    if (!r) return;
    const map = replacedByStem.get(stemId) ?? {};
    map[id] = r;
    replacedByStem.set(stemId, map);
  };
  for (const e of events) {
    if (e.superseded_by) {
      addReplacement(e.target_id, e.id);
      continue;
    }
    const count = Number(e.payload?.count);
    const fact: StemEventFact = {
      id: e.id,
      type: e.type,
      date: jstDateOf(e.occurred_at),
      occurredAt: e.occurred_at,
      recordedBy: e.recorded_by,
      severity: typeof e.payload?.severity === "string" ? e.payload.severity : null,
      damageKind: typeof e.payload?.kind === "string" ? e.payload.kind : null,
      count: e.type === "leaves_removed" && Number.isFinite(count) ? count : null,
    };
    const list = eventsByStem.get(e.target_id);
    if (list) list.push(fact);
    else eventsByStem.set(e.target_id, [fact]);
  }
  const currentByStem = new Map<string, LeafObservationFact[]>();
  const newByStem = new Map<string, LeafNewFact[]>();
  for (const o of observations) {
    if (o.superseded_by) {
      addReplacement(o.stem_id, o.id);
      continue;
    }
    const value = Number(o.value);
    if (!Number.isFinite(value)) continue;
    if (o.type === "leaves_new") {
      const list = newByStem.get(o.stem_id);
      if (list) list.push({ value, observedAt: o.observed_at });
      else newByStem.set(o.stem_id, [{ value, observedAt: o.observed_at }]);
      continue;
    }
    const fact: LeafObservationFact = { id: o.id, value, observedAt: o.observed_at, observedBy: o.observed_by };
    const list = currentByStem.get(o.stem_id);
    if (list) list.push(fact);
    else currentByStem.set(o.stem_id, [fact]);
  }

  return stems.map((s) => ({
    stemId: s.id,
    status: s.status,
    budEmergedAt: s.bud_emerged_at,
    events: eventsByStem.get(s.id) ?? [],
    harvestLowerDate: lowerByStem.get(s.id) ?? null,
    settings: settingsByField.get(s.mats.field_id) ?? resolveRecommendationSettings(null),
    adoptedAt: s.adopted_at,
    startedAt: s.started_at,
    initialLeafCount: s.initial_leaf_count,
    leavesNew: newByStem.get(s.id) ?? [],
    leavesCurrent: currentByStem.get(s.id) ?? [],
    replacedBy: replacedByStem.get(s.id) ?? {},
  }));
}

async function buildMatFacts(db: SupabaseClient, mats: readonly MatRow[], settingsByField: Map<string, ReturnType<typeof resolveRecommendationSettings>>): Promise<MatFacts[]> {
  const matIds = mats.map((m) => m.id);
  const harvested = await selectByIds<{ mat_id: string; harvested_at: string | null }>(
    matIds,
    (chunk, from, to) =>
      db
        .from("stems")
        .select("mat_id, harvested_at")
        .eq("status", "harvested")
        .in("mat_id", chunk)
        .order("id")
        .range(from, to) as unknown as PromiseLike<Page<{ mat_id: string; harvested_at: string | null }>>,
    "収穫済みの茎",
  );
  const harvestsByMat = new Map<string, string[]>();
  for (const h of harvested) {
    if (!h.harvested_at) continue;
    const list = harvestsByMat.get(h.mat_id);
    if (list) list.push(h.harvested_at);
    else harvestsByMat.set(h.mat_id, [h.harvested_at]);
  }
  // 収穫のある株だけ施肥を読む（収穫日の最小以降。日本時間の 0 時）
  const harvestedMats = [...harvestsByMat.keys()];
  const minHarvest = harvested.reduce<string | null>((m, h) => (h.harvested_at && (!m || h.harvested_at < m) ? h.harvested_at : m), null);
  const removedMats = mats.filter((m) => m.status === "removed").map((m) => m.id);
  const [fertilized, removals] = await Promise.all([
    harvestedMats.length === 0 || !minHarvest
      ? Promise.resolve([] as EventRow[])
      : selectByIds<EventRow>(
          harvestedMats,
          (chunk, from, to) =>
            db
              .from("events")
              .select(EVENT_COLUMNS)
              .eq("target_type", "mat")
              .eq("type", "fertilized")
              .in("target_id", chunk)
              .is("superseded_by", null)
              .gte("occurred_at", `${minHarvest}T00:00:00+09:00`)
              .order("id")
              .range(from, to) as unknown as PromiseLike<Page<EventRow>>,
          "施肥",
        ),
    selectByIds<EventRow>(
      removedMats,
      (chunk, from, to) =>
        db
          .from("events")
          .select(EVENT_COLUMNS)
          .eq("target_type", "mat")
          .eq("type", "mat_removed")
          .in("target_id", chunk)
          .is("superseded_by", null)
          .order("id")
          .range(from, to) as unknown as PromiseLike<Page<EventRow>>,
      "撤去",
    ),
  ]);
  const fertByMat = new Map<string, MatFacts["fertilizations"][number][]>();
  for (const f of fertilized) {
    const fact = { id: f.id, date: jstDateOf(f.occurred_at), recordedBy: f.recorded_by };
    const list = fertByMat.get(f.target_id);
    if (list) list.push(fact);
    else fertByMat.set(f.target_id, [fact]);
  }
  const removalByMat = new Map(removals.map((r) => [r.target_id, { id: r.id, recordedBy: r.recorded_by }]));
  return mats.map((m) => ({
    matId: m.id,
    status: m.status,
    harvestDates: harvestsByMat.get(m.id) ?? [],
    fertilizations: fertByMat.get(m.id) ?? [],
    removal: removalByMat.get(m.id) ?? null,
    settings: settingsByField.get(m.field_id) ?? resolveRecommendationSettings(null),
  }));
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

async function applyResolutions(db: SupabaseClient, resolve: readonly Resolution[]): Promise<number> {
  let n = 0;
  for (const r of resolve) {
    const { data, error } = await db
      .from("recommendations")
      .update({ status: r.status, resolution_note: r.note, resolved_by: r.resolvedBy, resolved_event_id: r.eventId })
      .eq("id", r.id)
      .eq("status", "open")
      .select("id");
    if (error) throw new Error(`提案を閉じられません（${error.message}）`);
    n += (data ?? []).length;
  }
  return n;
}

export async function recomputeRecommendations(
  db: SupabaseClient,
  scope: RecomputeScope,
  options: { now?: Date } = {},
): Promise<RecommendationResult> {
  const today = jstDateOf(options.now ?? new Date());
  const result: RecommendationResult = { stems: 0, mats: 0, created: 0, resolved: 0, errors: [] };
  try {
    const stems = await loadTargetStems(db, scope);
    // 圃場・株の範囲では撤去済みの株も読む（open の提案を閉じるため）
    const matRows = await loadTargetMats(db, scope, stems);
    result.stems = stems.length;
    result.mats = matRows.length;
    if (stems.length === 0 && matRows.length === 0) return result;

    const fieldIds = [...new Set([...stems.map((s) => s.mats.field_id), ...matRows.map((m) => m.field_id)])];
    const params = await db.from("field_recommendation_params").select(`field_id, ${RECOMMENDATION_PARAMS_COLUMNS}`).in("field_id", fieldIds);
    if (params.error) throw new Error(`提案の設定を読めません（${params.error.message}）`);
    const settingsByField = new Map(
      ((params.data ?? []) as unknown as (RecommendationParamsRow & { field_id: string })[]).map((p) => [p.field_id, resolveRecommendationSettings(p)]),
    );

    const [stemFacts, matFacts, existingStem, existingMat] = await Promise.all([
      stems.length > 0 ? buildStemFacts(db, stems, settingsByField) : Promise.resolve([] as StemFacts[]),
      matRows.length > 0 ? buildMatFacts(db, matRows, settingsByField) : Promise.resolve([] as MatFacts[]),
      loadExisting(db, "stem", stems.map((s) => s.id)),
      loadExisting(db, "mat", matRows.map((m) => m.id)),
    ]);

    const stemResult = evaluateStemRecommendations(stemFacts, existingStem, today);
    const matResult = evaluateMatRecommendations(matFacts, existingMat, today);
    result.resolved += await applyResolutions(db, [...stemResult.resolve, ...matResult.resolve]);
    result.created += await insertRecommendations(db, [...stemResult.create, ...matResult.create]);
  } catch (e) {
    result.errors.push((e as Error).message);
  }
  return result;
}
