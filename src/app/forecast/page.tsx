import { Suspense } from "react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { FieldFilter } from "@/components/app/field-filter";
import { ForecastView } from "@/components/app/forecast-view";
import { buildForecast } from "@/lib/forecast";
import { todayJst } from "@/lib/stemEvents";
import { createClient } from "@/lib/supabase/server";
import { fetchForecastStems } from "./data";

// 画面 7「予測一覧」（3-6、prediction.md 8 章）。UX-1 のプレースホルダーを置き換えた。
// 出蕾済みの茎の最新の収穫予測日（latest_estimates）を週（月曜始まり、日本時間の今日から見た今週）ごとに数え、茎ごとの一覧を出す。
// 圃場で絞り込める（/forecast?field=<id>）。PC 幅では本文を広げる（AppScreen の wide）。
// searchParams は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
export default function ForecastPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  return (
    <AppScreen title="予測" current="forecast" wide>
      <Suspense fallback={<LoadingText />}>
        <Forecast searchParams={searchParams} />
      </Suspense>
    </AppScreen>
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function Forecast({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const query = await searchParams;
  const raw = typeof query.field === "string" ? query.field : undefined;
  const fieldId = raw && UUID_RE.test(raw) ? raw : undefined;
  const supabase = await createClient();
  const [{ stems, error }, { data: fields }] = await Promise.all([
    fetchForecastStems(fieldId),
    supabase.from("fields").select("id, name").order("name"),
  ]);

  return (
    <>
      <div className="md:max-w-sm">
        <FieldFilter fields={fields ?? []} current={fieldId} basePath="/forecast" prefix="forecast" />
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          予測を取得できませんでした（{error}）
        </p>
      ) : (
        <ForecastView summary={buildForecast(stems, todayJst())} />
      )}
    </>
  );
}
