// 収穫予測日の再計算（3-3、prediction.md 2 章）: 出蕾済みの茎について harvest.ts（純粋関数）で予測し、estimates に追記する。
// DB のクライアントは呼び出し側が渡す:
// - 日次の気温取り込み（Cron）の後: service_role のクライアント（全組織。architecture.md 2・7 章の例外）
// - 出蕾・被害の記録、出蕾の訂正、予測の設定の保存、「今すぐ取り込む」の後: ログイン中のユーザーのクライアント（RLS で自組織だけ）
//
// - 追記のみ（上書き・削除しない。0021 で estimates の update / delete のポリシーを外した）。
//   ただし前回の推定（latest_estimates）と日付・版・入力がすべて同じなら追記しない（再計算が重なっても行を増やさない）
// - lost の茎・出蕾前の茎は対象外（推定しない）。organization_id は渡さない（INSERT トリガーが茎からコピーする）
// - 気温は圃場ごとに、出蕾日の翌日〜昨日の実績と、平年値の材料（normalsRange の 10 年分の日次）を読む
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildNormals, type DailyTemp, type HourlyDay } from "../gdd";
import { addDays, jstDateOf, normalsRange } from "../weather/dates";
import { WEATHER_SOURCE } from "../weather/sync";
import {
  type DamageRef,
  estimateSignature,
  harvestEstimateRow,
  type HarvestEstimateRow,
  predictHarvest,
} from "./harvest";

const PAGE = 1000;
const ID_CHUNK = 100;

export type RecomputeScope =
  | { stemIds: readonly string[] }
  | { fieldId: string; matId?: string; cultivarId?: string }
  | { matId: string };

export type RecomputeResult = {
  stems: number; // 対象にした出蕾済みの茎
  inserted: number; // 追記した推定
  unchanged: number; // 前回と同じで追記しなかった
  errors: string[];
};

type StemRow = {
  id: string;
  status: string;
  started_at: string;
  bud_emerged_at: string | null;
  mats: {
    id: string;
    field_id: string;
    cultivar_id: string;
    cultivars: { base_temp_c: number | string | null; flowering_to_harvest_gdd: number | string | null } | null;
  };
};

type Page<T> = { data: T[] | null; error: { message: string } | null };

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

function chunks<T>(list: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const num = (v: number | string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

async function loadStems(db: SupabaseClient, scope: RecomputeScope): Promise<StemRow[]> {
  const columns =
    "id, status, started_at, bud_emerged_at, mats!stems_mat_id_fkey!inner ( id, field_id, cultivar_id, cultivars ( base_temp_c, flowering_to_harvest_gdd ) )";
  if ("stemIds" in scope) {
    const out: StemRow[] = [];
    for (const ids of chunks([...new Set(scope.stemIds)])) {
      const { data, error } = await db.from("stems").select(columns).eq("status", "flowered").in("id", ids);
      if (error) throw new Error(`茎を読めません（${error.message}）`);
      out.push(...((data ?? []) as unknown as StemRow[]));
    }
    return out;
  }
  return selectAll<StemRow>((from, to) => {
    let q = db.from("stems").select(columns).eq("status", "flowered");
    if ("fieldId" in scope) {
      q = q.eq("mats.field_id", scope.fieldId);
      if (scope.cultivarId) q = q.eq("mats.cultivar_id", scope.cultivarId);
    }
    if (scope.matId) q = q.eq("mat_id", scope.matId);
    return q.order("id").range(from, to) as unknown as PromiseLike<Page<StemRow>>;
  }, "茎");
}

type EventRow = { id: string; target_type: string; target_id: string; occurred_at: string; payload: Record<string, unknown> | null };

async function loadEvents(
  db: SupabaseClient,
  type: "bud_emerged" | "damage",
  targetType: "stem" | "mat" | "field",
  ids: readonly string[],
): Promise<EventRow[]> {
  const out: EventRow[] = [];
  for (const chunk of chunks(ids)) {
    const rows = await selectAll<EventRow>(
      (from, to) =>
        db
          .from("events")
          .select("id, target_type, target_id, occurred_at, payload")
          .eq("type", type)
          .eq("target_type", targetType)
          .in("target_id", chunk)
          .is("superseded_by", null)
          .order("id")
          .range(from, to) as unknown as PromiseLike<Page<EventRow>>,
      "イベント",
    );
    out.push(...rows);
  }
  return out;
}

// 1 圃場の出蕾済みの茎を予測して追記する
async function recomputeField(db: SupabaseClient, fieldId: string, stems: StemRow[], today: string, result: RecomputeResult) {
  const stemIds = stems.map((s) => s.id);
  const matIds = [...new Set(stems.map((s) => s.mats.id))];
  const yesterday = addDays(today, -1);
  const earliestBud = stems.map((s) => s.bud_emerged_at as string).sort()[0];
  const actualFrom = addDays(earliestBud, 1);
  const normals = normalsRange(today);

  const [params, budEvents, stemDamages, matDamages, fieldDamages, daily, hourly, normalsDaily, latest] = await Promise.all([
    db.from("field_cultivar_params").select("cultivar_id, base_temp_c, flowering_to_harvest_gdd").eq("field_id", fieldId),
    loadEvents(db, "bud_emerged", "stem", stemIds),
    loadEvents(db, "damage", "stem", stemIds),
    loadEvents(db, "damage", "mat", matIds),
    loadEvents(db, "damage", "field", [fieldId]),
    actualFrom <= yesterday
      ? selectAll<{ date: string; t_mean: number | string | null }>(
          (from, to) =>
            db
              .from("weather_daily")
              .select("date, t_mean")
              .eq("field_id", fieldId)
              .eq("source", WEATHER_SOURCE)
              .gte("date", actualFrom)
              .lte("date", yesterday)
              .order("date")
              .range(from, to) as unknown as PromiseLike<Page<{ date: string; t_mean: number | string | null }>>,
          "気温",
        )
      : Promise.resolve([]),
    actualFrom <= yesterday
      ? selectAll<{ date: string; temps: (number | string)[] | null }>(
          (from, to) =>
            db
              .from("weather_hourly_days")
              .select("date, temps")
              .eq("field_id", fieldId)
              .eq("source", WEATHER_SOURCE)
              .gte("date", actualFrom)
              .lte("date", yesterday)
              .order("date")
              .range(from, to) as unknown as PromiseLike<Page<{ date: string; temps: (number | string)[] | null }>>,
          "時間別の気温",
        )
      : Promise.resolve([]),
    selectAll<{ date: string; t_mean: number | string | null }>(
      (from, to) =>
        db
          .from("weather_daily")
          .select("date, t_mean")
          .eq("field_id", fieldId)
          .eq("source", WEATHER_SOURCE)
          .gte("date", normals.from)
          .lte("date", normals.to)
          .order("date")
          .range(from, to) as unknown as PromiseLike<Page<{ date: string; t_mean: number | string | null }>>,
      "平年値の材料",
    ),
    (async () => {
      const out: { stem_id: string; value_date: string | null; lower_date: string | null; upper_date: string | null; model_version: string; inputs: unknown }[] = [];
      for (const chunk of chunks(stemIds)) {
        const { data, error } = await db
          .from("latest_estimates")
          .select("stem_id, value_date, lower_date, upper_date, model_version, inputs")
          .eq("kind", "harvest_date")
          .in("stem_id", chunk);
        if (error) throw new Error(`前回の推定を読めません（${error.message}）`);
        out.push(...((data ?? []) as typeof out));
      }
      return out;
    })(),
  ]);
  if (params.error) throw new Error(`予測の設定を読めません（${params.error.message}）`);

  const dailyTemps: DailyTemp[] = daily.map((r) => ({ date: r.date, tMean: num(r.t_mean) }));
  const hourlyTemps: HourlyDay[] = hourly.map((r) => ({ date: r.date, temps: (r.temps ?? []).map(Number) }));
  const normalsTable = buildNormals(normalsDaily.map((r) => ({ date: r.date, tMean: num(r.t_mean) })));
  const paramsByCultivar = new Map((params.data ?? []).map((p) => [p.cultivar_id as string, p]));
  const earliestByStem = new Map<string, string | null>();
  for (const e of budEvents) {
    const v = e.payload?.earliest_at;
    earliestByStem.set(e.target_id, typeof v === "string" && v !== "" ? v : null);
  }
  const toRef = (e: EventRow): DamageRef => ({
    targetType: e.target_type as DamageRef["targetType"],
    eventId: e.id,
    date: jstDateOf(e.occurred_at),
    severity: String(e.payload?.severity ?? ""),
  });
  const fieldRefs = fieldDamages.map(toRef);
  const latestByStem = new Map(latest.map((l) => [l.stem_id, l]));

  const rows: HarvestEstimateRow[] = [];
  for (const s of stems) {
    const p = paramsByCultivar.get(s.mats.cultivar_id);
    const damages = [
      ...stemDamages.filter((e) => e.target_id === s.id).map(toRef),
      ...matDamages.filter((e) => e.target_id === s.mats.id).map(toRef),
      ...fieldRefs,
    ];
    const prediction = predictHarvest({
      stemStatus: s.status,
      stemStartedAt: s.started_at,
      budDate: s.bud_emerged_at,
      earliestAt: earliestByStem.get(s.id) ?? null,
      today,
      daily: dailyTemps.filter((d) => s.bud_emerged_at !== null && d.date > s.bud_emerged_at),
      hourly: hourlyTemps.filter((d) => s.bud_emerged_at !== null && d.date > s.bud_emerged_at),
      normals: normalsTable,
      fieldBaseTempC: num(p?.base_temp_c as number | string | null | undefined),
      cultivarBaseTempC: num(s.mats.cultivars?.base_temp_c),
      fieldTargetGdd: num(p?.flowering_to_harvest_gdd as number | string | null | undefined),
      cultivarTargetGdd: num(s.mats.cultivars?.flowering_to_harvest_gdd),
      damages,
    });
    if (prediction.kind === "skipped") continue;
    const row = harvestEstimateRow(s.id, prediction);
    const prev = latestByStem.get(s.id);
    if (prev && estimateSignature(prev) === estimateSignature(row)) {
      result.unchanged++;
      continue;
    }
    rows.push(row);
  }
  for (const chunk of chunks(rows, PAGE)) {
    const { error } = await db.from("estimates").insert(chunk);
    if (error) throw new Error(`推定を保存できません（${error.message}）`);
    result.inserted += chunk.length;
  }
}

export async function recomputeHarvestEstimates(
  db: SupabaseClient,
  scope: RecomputeScope,
  options: { now?: Date } = {},
): Promise<RecomputeResult> {
  const today = jstDateOf(options.now ?? new Date());
  const result: RecomputeResult = { stems: 0, inserted: 0, unchanged: 0, errors: [] };
  let stems: StemRow[];
  try {
    stems = (await loadStems(db, scope)).filter((s) => s.bud_emerged_at);
  } catch (e) {
    result.errors.push((e as Error).message);
    return result;
  }
  result.stems = stems.length;
  const byField = new Map<string, StemRow[]>();
  for (const s of stems) {
    const list = byField.get(s.mats.field_id);
    if (list) list.push(s);
    else byField.set(s.mats.field_id, [s]);
  }
  for (const [fieldId, list] of byField) {
    try {
      await recomputeField(db, fieldId, list, today, result);
    } catch (e) {
      result.errors.push(`圃場 ${fieldId}: ${(e as Error).message}`);
    }
  }
  return result;
}

// 例外を投げずにログへ（記録・設定の保存そのものは成功させる。推定は次の再計算で追いつく）
export async function recomputeHarvestEstimatesQuietly(db: SupabaseClient, scope: RecomputeScope, label: string): Promise<RecomputeResult | null> {
  try {
    const r = await recomputeHarvestEstimates(db, scope);
    if (r.errors.length > 0) console.error(`harvest recompute (${label}) errors`, r.errors);
    return r;
  } catch (e) {
    console.error(`harvest recompute (${label}) failed`, e);
    return null;
  }
}
