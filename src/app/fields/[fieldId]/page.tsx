import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import { FIELD_HISTORY_LIMIT, type FieldDetailData } from "@/lib/fields/detail";
import type { EventRow } from "@/lib/stems/records";
import { createClient } from "@/lib/supabase/server";
import { FieldDetailView } from "./field-detail-view";
import { PredictionSettingsSection } from "./prediction-settings";
import { RecommendationSettingsSection } from "./recommendation-settings";
import { WeatherStatusSection } from "./weather-status";

// 「気温を今すぐ取り込む」（3-1、weather-actions.ts）は 10 年分の平年値の材料を取ると十数秒かかる。
// Server Action の時間制限はページの maxDuration で決まる（next/dist/docs の maxDuration）
export const maxDuration = 60;

// 圃場の詳細: 名前・記号・代表点・メモと地図への導線、編集（/fields/[fieldId]/edit、UX-2）への導線、
// 施肥の一括入力（/fields/[fieldId]/fertilize、2-4）への導線。
// 圃場の被害（2-5）の「被害を記録」と、保存後に株へ一括（/fields/[fieldId]/damage/[eventId]）への導線。
// 圃場単位のイベント（target_type=field。圃場の被害など）は「圃場の記録」に新しい順で出す（株の記録・茎の履歴と同じ表示）。
// 気温の取り込みの状況（3-1、weather-status.tsx）。予測の設定（3-2、prediction-settings.tsx）。土壌分析の入力は後のタスクで追加する。
// 表示は field-detail-view.tsx（オフラインの殻 2-9 と共通）。ここはサーバーでのデータの取得だけ。
// params は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
export default function FieldDetailPage({ params }: { params: Promise<{ fieldId: string }> }) {
  return (
    <AppScreen title="圃場の詳細" backHref="/fields" backLabel="圃場" current="settings">
      <Suspense fallback={<LoadingText />}>
        <FieldDetail params={params} />
      </Suspense>
    </AppScreen>
  );
}

async function FieldDetail({ params }: { params: Promise<{ fieldId: string }> }) {
  const { fieldId } = await params;
  const supabase = await createClient();
  // PERF-1: ユーザーの確認と圃場の select を並べる（直列の往復 2 → 1）
  const [currentUser, { data: field }, { data: fieldEvents, error: fieldEventsError }] = await Promise.all([
    getCurrentUser(),
    supabase.from("fields").select("id, name, code, center_lat, center_lng, notes").eq("id", fieldId).maybeSingle(),
    // 圃場単位のイベントの履歴（新しい順。訂正済みも打ち消し表示で出す）
    supabase
      .from("events")
      .select("id, type, occurred_at, payload, note, superseded_by, profiles ( display_name )")
      .eq("target_type", "field")
      .eq("target_id", fieldId)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(FIELD_HISTORY_LIMIT),
  ]);
  userOrRedirect(currentUser);
  if (!field) notFound();

  const history: EventRow[] = (fieldEvents ?? []).map((e) => ({
    id: e.id,
    type: e.type,
    occurred_at: e.occurred_at,
    payload: (e.payload as Record<string, unknown> | null) ?? null,
    superseded_by: e.superseded_by,
    note: e.note,
    recorder_name: (e.profiles as unknown as { display_name: string | null } | null)?.display_name ?? null,
  }));
  const data: FieldDetailData = { field, history, historyError: fieldEventsError?.message ?? null };

  return (
    <>
      <FieldDetailView data={data} />
      {/* 気温の取り込みの状況（3-1）。オフラインの殻には出さないので FieldDetailView の外 */}
      <Suspense fallback={<LoadingText>気温を読み込み中…</LoadingText>}>
        <WeatherStatusSection fieldId={field.id} />
      </Suspense>
      {/* 予測の設定（3-2。圃場 × 品種の基準温度・目標積算温度）。オフラインの殻には出さない */}
      <Suspense fallback={<LoadingText>予測の設定を読み込み中…</LoadingText>}>
        <PredictionSettingsSection fieldId={field.id} />
      </Suspense>
      {/* 提案の設定（3-4。袋掛け・摘蕾の日数 N、収穫期の日数）。オフラインの殻には出さない */}
      <Suspense fallback={<LoadingText>提案の設定を読み込み中…</LoadingText>}>
        <RecommendationSettingsSection fieldId={field.id} />
      </Suspense>
    </>
  );
}
