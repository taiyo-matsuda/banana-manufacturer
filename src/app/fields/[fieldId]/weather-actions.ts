"use server";

import { cookies } from "next/headers";
import { refresh } from "next/cache";
import { requireUser } from "@/lib/auth/current-user";
import { recomputeHarvestEstimatesQuietly } from "@/lib/prediction/recompute";
import { createClient } from "@/lib/supabase/server";
import { MOCK_FAULT_NAME, mockFaultFrom } from "@/lib/weather/server";
import { syncFieldWeatherAsUser } from "@/lib/weather/user-sync";
import type { WeatherNowState } from "@/lib/weather/now-state";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Vercel の関数の時間制限（page.tsx の maxDuration = 60）より前に打ち切る。残りは次回の取り込みで続きから
const BUDGET_MS = 45_000;

// 圃場の詳細の「今すぐ取り込む」（3-1）。日次の取り込み（Cron）と同じ処理（平年値の材料まで）を、
// ログイン中のユーザーのクライアント（RLS で自組織の圃場だけ）で 1 圃場だけ走らせる。
export async function syncWeatherNow(prev: WeatherNowState, formData: FormData): Promise<WeatherNowState> {
  const startedAt = Date.now();
  const fieldId = String(formData.get("fieldId") ?? "");
  const supabase = await createClient();
  await requireUser();
  if (!UUID_PATTERN.test(fieldId)) return { ...prev, message: null, error: "圃場が見つかりません" };

  // E2E: 開発サーバーのモックのときだけ、Cookie で失敗を起こせる（本番では読まない）
  const fault = mockFaultFrom((await cookies()).get(MOCK_FAULT_NAME)?.value);
  const result = await syncFieldWeatherAsUser(supabase, fieldId, {
    includeNormals: true,
    fault,
    deadline: startedAt + BUDGET_MS,
  });
  if (!result) return { ...prev, message: null, error: "圃場が見つかりません" };

  if (result.errors.length > 0) console.error("weather sync (manual) errors", fieldId, result.errors);
  // 3-3: 日次の取り込みと同じく、取り込んだ後にこの圃場の出蕾済みの茎の収穫予測日を再計算する
  await recomputeHarvestEstimatesQuietly(supabase, { fieldId }, "manual weather sync");
  refresh();
  const done = prev.done + 1;
  if (result.errors.length > 0) {
    return { done, message: null, error: `一部を取り込めませんでした（${result.days}日分は保存）。次回の取り込みで埋め直します` };
  }
  if (result.timedOut) {
    return { done, message: `${result.days}日分を取り込みました。残りは次回の取り込みで続きから取ります`, error: null };
  }
  return { done, message: `${result.days}日分を取り込みました`, error: null };
}
