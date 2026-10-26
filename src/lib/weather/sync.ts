// 1 圃場の気温の取り込み（Open-Meteo → weather_hourly / weather_daily、取り込みの記録 → weather_sync_status）。
// DB のクライアントと fetch は呼び出し側が渡す:
// - 日次（Cron の Route Handler）: service_role のクライアント（全組織の圃場。architecture.md 2・7 章の例外）
// - 登録・代表点の変更（Server Action の after()）、圃場の詳細の「今すぐ取り込む」: ログイン中のユーザーのクライアント（RLS で自組織だけ）
// 何を取るかは plan.ts（純粋関数）、時間別 → 日次は aggregate.ts（純粋関数）。ここは読み書きの順序だけ。
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyOffset, hourlyTimestamp, hourlyToDaily, round1, type DailyWeather } from "./aggregate";
import { daysBetween, jstDateOf } from "./dates";
import {
  archiveUrl,
  fetchHourly,
  forecastUrl,
  type FetchFn,
  type HourlyPoint,
  type WeatherApi,
} from "./open-meteo";
import { fillStartDate, planSync, type ExistingDay } from "./plan";
import { summarizeSyncFailures, type SyncFailure } from "./summary";

export const WEATHER_SOURCE = "open-meteo";
const PAGE = 1000;

export type SyncField = {
  id: string;
  created_at: string;
  center_lat: number;
  center_lng: number;
  weather_lat: number | null;
  weather_lng: number | null;
  temperature_offset_c: number | string | null;
};

export const SYNC_FIELD_COLUMNS =
  "id, created_at, center_lat, center_lng, weather_lat, weather_lng, temperature_offset_c";

export type SyncOptions = {
  // 平年値の材料（過去 10 年分）も取るか
  includeNormals: boolean;
  // この時刻（epoch ms）を過ぎたら過去 API の残りは次回に回す（Vercel の関数の時間制限）
  deadline?: number;
  now?: Date;
};

export type SyncResult = {
  fieldId: string;
  days: number; // 保存した日別の行数（日付の数。予報と過去の両方で書いた日は 1 日と数える）
  hours: number; // 保存した時間別の行数
  missingBefore: number; // 取り込み前に過去 API の対象だった日数
  errors: string[]; // 詳細（ログ用）
  failures: SyncFailure[]; // 要約用（summary.ts）
  timedOut: boolean;
};

// 気温の代表点: weather_lat/lng があればそれ、なければ圃場の代表点
export function weatherPoint(field: SyncField): { lat: number; lng: number } {
  if (field.weather_lat !== null && field.weather_lng !== null) {
    return { lat: Number(field.weather_lat), lng: Number(field.weather_lng) };
  }
  return { lat: Number(field.center_lat), lng: Number(field.center_lng) };
}

async function loadExisting(db: SupabaseClient, fieldId: string): Promise<Map<string, ExistingDay>> {
  const existing = new Map<string, ExistingDay>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("weather_daily")
      .select("date, api, temperature_offset_c")
      .eq("field_id", fieldId)
      .eq("source", WEATHER_SOURCE)
      .order("date")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`既存の日別気温を読めません（${error.message}）`);
    for (const r of data ?? []) {
      existing.set(r.date as string, {
        api: r.api as ExistingDay["api"],
        offset: Number(r.temperature_offset_c),
      });
    }
    if (!data || data.length < PAGE) break;
  }
  return existing;
}

async function upsertChunks(
  db: SupabaseClient,
  table: "weather_daily" | "weather_hourly",
  rows: Record<string, unknown>[],
  onConflict: string,
) {
  for (let i = 0; i < rows.length; i += PAGE) {
    const { error } = await db.from(table).upsert(rows.slice(i, i + PAGE), { onConflict });
    if (error) throw new Error(`${table} に保存できません（${error.message}）`);
  }
}

function dailyRows(fieldId: string, daily: DailyWeather[], api: WeatherApi, offset: number, fetchedAt: string) {
  return daily.map((d) => ({
    field_id: fieldId,
    date: d.date,
    source: WEATHER_SOURCE,
    api,
    t_mean: d.t_mean,
    t_min: d.t_min,
    t_max: d.t_max,
    precip_mm: d.precip_mm,
    wind_max_ms: d.wind_max_ms,
    temperature_offset_c: offset,
    fetched_at: fetchedAt,
  }));
}

function hourlyRows(fieldId: string, points: HourlyPoint[], api: WeatherApi, offset: number, fetchedAt: string) {
  return points.map((p) => ({
    field_id: fieldId,
    ts: hourlyTimestamp(p.time),
    source: WEATHER_SOURCE,
    api,
    temp_c: p.temp === null ? null : round1(p.temp),
    precip_mm: p.precip === null ? null : round1(p.precip),
    wind_max_ms: p.wind === null ? null : round1(p.wind),
    temperature_offset_c: offset,
    fetched_at: fetchedAt,
  }));
}

export async function syncFieldWeather(
  db: SupabaseClient,
  fetchFn: FetchFn,
  field: SyncField,
  options: SyncOptions,
): Promise<SyncResult> {
  const now = options.now ?? new Date();
  const today = jstDateOf(now);
  const fetchedAt = now.toISOString();
  const offset = Number(field.temperature_offset_c ?? 0);
  const { lat, lng } = weatherPoint(field);
  const result: SyncResult = { fieldId: field.id, days: 0, hours: 0, missingBefore: 0, errors: [], failures: [], timedOut: false };
  const savedDates = new Set<string>();
  // 記録する座標。代表点の変更を確かめられなかった・前の地点の値を消せなかったときは null
  // （record_weather_sync は null なら前の座標を残すので、次回も「変更あり」として取り直す）
  let recordPoint: { lat: number; lng: number } | null = null;
  const fail = (kind: SyncFailure["kind"], message: string, days: number, detail: string) => {
    result.errors.push(detail);
    result.failures.push({ kind, message, days });
  };

  try {
    const [statusRes, stemRes] = await Promise.all([
      db.from("weather_sync_status").select("lat, lng").eq("field_id", field.id).maybeSingle(),
      // 最も古い茎の開始日（株を通して圃場に属する茎）
      db
        .from("stems")
        .select("started_at, mats!stems_mat_id_fkey!inner ( field_id )")
        .eq("mats.field_id", field.id)
        .order("started_at", { ascending: true })
        .limit(1),
    ]);
    if (statusRes.error) throw new Error(`取り込みの記録を読めません（${statusRes.error.message}）`);
    if (stemRes.error) throw new Error(`茎を読めません（${stemRes.error.message}）`);

    // 代表点が変わっていたら、前の地点の値を消して取り直す（気象は観測ではなく外部の値なので消してよい）
    const prev = statusRes.data as { lat: number | null; lng: number | null } | null;
    if (prev && prev.lat !== null && (Number(prev.lat) !== lat || Number(prev.lng) !== lng)) {
      for (const table of ["weather_daily", "weather_hourly"] as const) {
        const { error } = await db.from(table).delete().eq("field_id", field.id);
        if (error) throw new Error(`前の地点の気温を消せません（${error.message}）`);
      }
    }
    recordPoint = { lat, lng };

    const existing = await loadExisting(db, field.id);
    const oldestStem = (stemRes.data?.[0]?.started_at as string | undefined) ?? null;
    const plan = planSync({
      today,
      fillStart: fillStartDate(jstDateOf(field.created_at), oldestStem),
      includeNormals: options.includeNormals,
      existing,
      offset,
    });
    result.missingBefore = plan.missingCount;

    // 1. 予報 API: 直近の日（確定値がまだない日だけ書く）
    try {
      const points = applyOffset(await fetchHourly(fetchFn, forecastUrl(lat, lng)), offset).filter((p) =>
        plan.forecastDates.has(p.time.slice(0, 10)),
      );
      const daily = hourlyToDaily(points);
      const complete = new Set(daily.map((d) => d.date));
      await upsertChunks(db, "weather_daily", dailyRows(field.id, daily, "forecast", offset, fetchedAt), "field_id,date,source");
      const hourly = points.filter((p) => complete.has(p.time.slice(0, 10)));
      await upsertChunks(db, "weather_hourly", hourlyRows(field.id, hourly, "forecast", offset, fetchedAt), "field_id,ts,source");
      for (const d of daily) savedDates.add(d.date);
      result.hours += hourly.length;
    } catch (e) {
      const message = (e as Error).message;
      fail("forecast", message, plan.forecastDates.size, `予報: ${message}`);
    }

    // 2. 過去 API: 欠けた日・暫定値の日・平年値の材料（新しい順）。失敗した期間は次回の取り込みで再び対象になる
    for (const range of plan.archiveRanges) {
      if (options.deadline !== undefined && Date.now() > options.deadline) {
        result.timedOut = true;
        break;
      }
      try {
        const points = applyOffset(await fetchHourly(fetchFn, archiveUrl(lat, lng, range.from, range.to)), offset).filter(
          (p) => {
            const d = p.time.slice(0, 10);
            return d >= range.from && d <= range.to;
          },
        );
        const daily = hourlyToDaily(points);
        const complete = new Set(daily.map((d) => d.date));
        await upsertChunks(db, "weather_daily", dailyRows(field.id, daily, "archive", offset, fetchedAt), "field_id,date,source");
        // 時間別は埋めるべき期間（登録日 / 最も古い茎 〜）だけ。10 年分は日次だけ
        const hourly = points.filter((p) => {
          const d = p.time.slice(0, 10);
          return d >= plan.hourlyFrom && complete.has(d);
        });
        await upsertChunks(db, "weather_hourly", hourlyRows(field.id, hourly, "archive", offset, fetchedAt), "field_id,ts,source");
        for (const d of daily) savedDates.add(d.date);
        result.hours += hourly.length;
      } catch (e) {
        const message = (e as Error).message;
        fail("archive", message, daysBetween(range.from, range.to) + 1, `過去 ${range.from}〜${range.to}: ${message}`);
      }
    }
  } catch (e) {
    const message = (e as Error).message;
    fail("other", message, 0, message);
  }
  result.days = savedDates.size;

  // 取り込みの記録（最終実行・件数・要約したエラー・使った座標）。詳細は result.errors（呼び出し側がログに出す）
  const { error } = await db.rpc("record_weather_sync", {
    p_field_id: field.id,
    p_ran_at: fetchedAt,
    p_days: result.days,
    p_error: summarizeSyncFailures(result.failures),
    p_lat: recordPoint?.lat ?? null,
    p_lng: recordPoint?.lng ?? null,
  });
  if (error) result.errors.push(`取り込みの記録を書けません（${error.message}）`);
  return result;
}
