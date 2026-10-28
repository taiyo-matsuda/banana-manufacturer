import "server-only";

import { notFound } from "next/navigation";
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import { type StemGdd, stemGdd, stemGddPeriod } from "@/lib/gdd";
import { PHOTO_SIGNED_URL_TTL_SEC } from "@/lib/photos";
import { type HarvestDisplay, harvestDisplayFrom } from "@/lib/prediction/harvest";
import { recomputeHarvestEstimatesQuietly } from "@/lib/prediction/recompute";
import { todayJst } from "@/lib/stemEvents";
import type { EventRow, ObservationRow, PhotoRow } from "@/lib/stems/records";
import { buildStemView, type StemView } from "@/lib/stems/view";
import { createClient } from "@/lib/supabase/server";
import { addDays } from "@/lib/weather/dates";
import { WEATHER_SOURCE } from "@/lib/weather/sync";

export type { StemView };

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

// 茎の行に埋め込む株（3-2 の積算温度のため、圃場・品種・基準温度の上書き・取り込みの記録も一緒に取る）
type MatRow = {
  id: string;
  code: string;
  field_id: string;
  cultivar_id: string;
  cultivars: { base_temp_c: number | string | null } | null;
  fields: {
    weather_sync_status: { last_success_at: string | null } | null;
    field_cultivar_params: { cultivar_id: string; base_temp_c: number | string | null }[] | null;
  } | null;
};

// 茎の記録入力（画面 4）と履歴（画面 8）で共通の読み込み。
// Suspense 境界の内側から呼ぶ（cookies() を読む）。他組織の茎は RLS で見えず notFound。
// PERF-1: ユーザー・茎・観測・イベント・写真は stemId だけで引けるので、1 回の Promise.all で並べて取る
// （Supabase への直列の往復は 1 回。写真の署名付き URL・積算温度の気温が要るときだけ、並べてもう 1 回）。
// 組織 ID は茎の行の organization_id を使う（RLS の stems_all で見える茎は current_org() の行だけなので、
// profile の organization_id と同じ値。profile の select を省く）。
export async function loadStem(stemId: string): Promise<StemView> {
  return (await loadStemInternal(stemId, false)).stem;
}

// 茎の記録入力（画面 4）: 3-2 で、出蕾済みの茎の「出蕾から N 日、積算温度」も計算する。
// 気温は茎の圃場の、出蕾日の翌日〜積算の最終日の分だけ引く（全期間・全圃場は引かない）。
// 茎の行（出蕾日・圃場）を読んでから引くので、写真の署名付き URL と同じ 2 回目の往復に並べる（直列の往復は増やさない）。
// 計算結果は保存しない（推定の保存は 3-3 から）。
// 3-3: 出蕾済みの茎の収穫予測日（estimates の最新 = latest_estimates）も読む。予測は記録・設定・日次の取り込みの後に
// 再計算して追記されるが、まだ 1 件も無い出蕾済みの茎（再計算の呼び出しが届かなかった等）はここで 1 回計算して追記する。
export type StemRecordData = { stem: StemView; gdd: StemGdd | null; harvest: HarvestDisplay | null };

export async function loadStemRecord(stemId: string): Promise<StemRecordData> {
  return loadStemInternal(stemId, true);
}

type LatestHarvestRow = {
  value_date: string | null;
  lower_date: string | null;
  upper_date: string | null;
  inputs: unknown;
  computed_at: string;
};

function latestHarvest(supabase: SupabaseServerClient, stemId: string) {
  return supabase
    .from("latest_estimates")
    .select("value_date, lower_date, upper_date, inputs, computed_at")
    .eq("stem_id", stemId)
    .eq("kind", "harvest_date")
    .maybeSingle();
}

async function loadStemInternal(stemId: string, withGdd: boolean): Promise<StemRecordData> {
  const supabase = await createClient();

  // stems → mats は FK が 2 本（mat_id と origin_stem の逆参照）あるので、埋め込む関係を明示する
  const [
    currentUser,
    { data: stem, error: stemError },
    { data: observations, error: obsError },
    { data: events, error: evError },
    { data: photos, error: phError },
    harvestRes,
  ] = await Promise.all([
    getCurrentUser(),
    supabase
      .from("stems")
      .select(
        "id, organization_id, generation, status, initial_leaf_count, bud_emerged_at, harvested_at, ended_at, " +
          "mats!stems_mat_id_fkey ( id, code, field_id, cultivar_id, cultivars ( base_temp_c ), " +
          "fields ( weather_sync_status ( last_success_at ), field_cultivar_params ( cultivar_id, base_temp_c ) ) )",
      )
      .eq("id", stemId)
      .maybeSingle(),
    supabase
      .from("observations")
      .select("id, type, value, observed_at, superseded_by, profiles ( display_name )")
      .eq("stem_id", stemId)
      .order("observed_at", { ascending: false }),
    supabase
      .from("events")
      .select("id, type, occurred_at, payload, superseded_by, profiles ( display_name )")
      .eq("target_type", "stem")
      .eq("target_id", stemId)
      .order("occurred_at", { ascending: false }),
    supabase
      .from("photos")
      .select("id, kind, taken_at, storage_path, profiles ( display_name )")
      .eq("target_type", "stem")
      .eq("target_id", stemId)
      .order("taken_at", { ascending: false }),
    withGdd ? latestHarvest(supabase, stemId) : Promise.resolve(null),
  ]);
  const user = userOrRedirect(currentUser);
  if (stemError) throw new Error(`茎を取得できませんでした（${stemError.message}）`);
  if (!stem) notFound();
  const stemRow = stem as unknown as {
    id: string;
    organization_id: string;
    generation: number;
    status: string;
    initial_leaf_count: number | null;
    bud_emerged_at: string | null;
    harvested_at: string | null;
    ended_at: string | null;
    mats: MatRow | null;
  };
  const matRow = stemRow.mats;
  if (!matRow) notFound();
  const mat = { id: matRow.id, code: matRow.code };
  if (obsError) throw new Error(`観測を取得できませんでした（${obsError.message}）`);
  if (evError) throw new Error(`イベントを取得できませんでした（${evError.message}）`);
  if (phError) throw new Error(`写真を取得できませんでした（${phError.message}）`);

  // 2 回目の往復: 写真の署名付き URL（非公開バケットなので 1 時間の URL をサーバーで作る。作れない写真は url=null）と、
  // 積算温度の気温（出蕾済みの茎の記録入力のときだけ）。どちらも要るときは並べて取る
  const signedUrlByPath = new Map<string, string>();
  const [, gdd, harvestRow] = await Promise.all([
    (async () => {
      if (!photos || photos.length === 0) return;
      const { data: signed, error: signError } = await supabase.storage
        .from("photos")
        .createSignedUrls(
          photos.map((p) => p.storage_path),
          PHOTO_SIGNED_URL_TTL_SEC,
        );
      if (signError) console.error("createSignedUrls failed", { message: signError.message });
      for (const s of signed ?? []) {
        if (s.signedUrl && s.path) signedUrlByPath.set(s.path, s.signedUrl);
      }
    })(),
    withGdd && stemRow.bud_emerged_at
      ? loadStemGdd(supabase, {
          budDate: stemRow.bud_emerged_at,
          harvestedAt: stemRow.harvested_at,
          endedAt: stemRow.ended_at,
          mat: matRow,
        })
      : Promise.resolve(null),
    (async (): Promise<LatestHarvestRow | null> => {
      if (!withGdd || stemRow.status !== "flowered") return null;
      if (harvestRes?.error) throw new Error(`収穫予測を取得できませんでした（${harvestRes.error.message}）`);
      if (harvestRes?.data) return harvestRes.data as LatestHarvestRow;
      // まだ推定が無い出蕾済みの茎: 1 回計算して追記し、読み直す
      // （読み直しは estimates から。同じ GET を同じ描画の中で繰り返すと、fetch のメモ化で最初の空の結果が返る）
      await recomputeHarvestEstimatesQuietly(supabase, { stemIds: [stemId] }, "stem page");
      const { data } = await supabase
        .from("estimates")
        .select("value_date, lower_date, upper_date, inputs, computed_at")
        .eq("stem_id", stemId)
        .eq("kind", "harvest_date")
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data as LatestHarvestRow | null) ?? null;
    })(),
  ]);

  const nameOf = (p: unknown) => (p as { display_name: string | null } | null)?.display_name ?? null;
  const observationRows: ObservationRow[] = (observations ?? []).map((o) => ({
    id: o.id,
    type: o.type,
    value: Number(o.value),
    observed_at: o.observed_at,
    superseded_by: o.superseded_by,
    observer_name: nameOf(o.profiles),
  }));
  const eventRows: EventRow[] = (events ?? []).map((e) => ({
    id: e.id,
    type: e.type,
    occurred_at: e.occurred_at,
    payload: (e.payload as Record<string, unknown> | null) ?? null,
    superseded_by: e.superseded_by,
    recorder_name: nameOf(e.profiles),
  }));
  const photoRows: PhotoRow[] = (photos ?? []).map((p) => ({
    id: p.id,
    kind: p.kind,
    taken_at: p.taken_at,
    url: signedUrlByPath.get(p.storage_path) ?? null,
    taker_name: nameOf(p.profiles),
  }));

  // 累計葉数・検算・履歴などの計算はオフラインの殻（2-9）と共通（src/lib/stems/view.ts）
  const view = buildStemView({
    id: stemRow.id,
    generation: stemRow.generation,
    status: stemRow.status,
    initialLeafCount: stemRow.initial_leaf_count ?? 0,
    mat,
    userId: user.id,
    organizationId: stemRow.organization_id,
    observations: observationRows,
    events: eventRows,
    photos: photoRows,
  });
  return { stem: view, gdd, harvest: harvestDisplayFrom(harvestRow) };
}

// 出蕾済みの茎の積算温度（3-2、src/lib/gdd.ts で計算）。気温は茎の圃場の、出蕾日の翌日〜積算の最終日の分だけ。
// 時間別は weather_hourly_days（0020。日本時間の日ごとに気温の配列）で引く（max_rows 1000 に当たらない）
async function loadStemGdd(
  supabase: SupabaseServerClient,
  input: { budDate: string; harvestedAt: string | null; endedAt: string | null; mat: MatRow },
): Promise<StemGdd> {
  const { budDate, harvestedAt, endedAt, mat } = input;
  const today = todayJst();
  const from = addDays(budDate, 1);
  const to = stemGddPeriod({ budDate, today, harvestedAt, endedAt }).accumulateTo;

  let daily: { date: string; tMean: number | null }[] = [];
  let hourly: { date: string; temps: number[] }[] = [];
  if (from <= to) {
    const [{ data: dailyRows, error: dailyError }, { data: hourlyRows, error: hourlyError }] = await Promise.all([
      supabase
        .from("weather_daily")
        .select("date, t_mean")
        .eq("field_id", mat.field_id)
        .eq("source", WEATHER_SOURCE)
        .gte("date", from)
        .lte("date", to)
        .order("date"),
      supabase
        .from("weather_hourly_days")
        .select("date, temps")
        .eq("field_id", mat.field_id)
        .eq("source", WEATHER_SOURCE)
        .gte("date", from)
        .lte("date", to)
        .order("date"),
    ]);
    if (dailyError) throw new Error(`気温を取得できませんでした（${dailyError.message}）`);
    if (hourlyError) throw new Error(`気温を取得できませんでした（${hourlyError.message}）`);
    daily = (dailyRows ?? []).map((r) => ({
      date: r.date as string,
      tMean: r.t_mean === null ? null : Number(r.t_mean),
    }));
    hourly = ((hourlyRows ?? []) as { date: string; temps: (number | string)[] | null }[]).map((r) => ({
      date: r.date,
      temps: (r.temps ?? []).map(Number),
    }));
  }

  const override = mat.fields?.field_cultivar_params?.find((p) => p.cultivar_id === mat.cultivar_id)?.base_temp_c ?? null;
  const cultivarBase = mat.cultivars?.base_temp_c ?? null;
  return stemGdd({
    budDate,
    today,
    harvestedAt,
    endedAt,
    daily,
    hourly,
    fieldBaseTempC: override === null ? null : Number(override),
    cultivarBaseTempC: cultivarBase === null ? null : Number(cultivarBase),
    weatherEverSynced: Boolean(mat.fields?.weather_sync_status?.last_success_at),
  });
}
