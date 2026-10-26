import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { weatherFetcher } from "./server";
import type { MockFault } from "./mock";
import { SYNC_FIELD_COLUMNS, syncFieldWeather, type SyncField, type SyncResult } from "./sync";

// ログイン中のユーザーのクライアント（RLS で自組織の圃場だけ）で 1 圃場の気温を取り込む。
// - 圃場の登録・代表点の変更（Server Action の after()）: 平年値の材料は取らない（応答の後でも短く済ませる。10 年分は次回の Cron）
// - 圃場の詳細の「今すぐ取り込む」: 日次の取り込み（Cron）と同じく平年値の材料まで取る
// service_role は使わない（architecture.md 2 章）。
export async function syncFieldWeatherAsUser(
  supabase: SupabaseClient,
  fieldId: string,
  options: { includeNormals: boolean; fault?: MockFault; deadline?: number },
): Promise<SyncResult | null> {
  const { data: field, error } = await supabase.from("fields").select(SYNC_FIELD_COLUMNS).eq("id", fieldId).maybeSingle();
  if (error || !field) return null;
  return syncFieldWeather(supabase, weatherFetcher(options.fault ?? null), field as SyncField, {
    includeNormals: options.includeNormals,
    deadline: options.deadline,
  });
}

// after() から呼ぶ。例外は投げずにログへ（記録は weather_sync_status に残る）
export async function syncWeatherInBackground(supabase: SupabaseClient, fieldId: string): Promise<void> {
  try {
    const r = await syncFieldWeatherAsUser(supabase, fieldId, { includeNormals: false });
    if (r && r.errors.length > 0) console.error("weather sync (registration) errors", fieldId, r.errors);
  } catch (e) {
    console.error("weather sync (registration) failed", fieldId, e);
  }
}
