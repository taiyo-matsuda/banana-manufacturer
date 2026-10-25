import { Suspense } from "react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { WeeklyFieldFilter } from "@/components/app/weekly-field-filter";
import { WeeklyList, WeeklyThresholdToggle } from "@/components/app/weekly-list";
import { createClient } from "@/lib/supabase/server";
import { fetchWeeklyRows } from "./data";

// 今週見る株の全件（2-7、画面 1 の「すべて見る」）。ホームと同じ一覧（src/components/app/weekly-list.tsx）。
// 圃場で絞り込める（/weekly?field=<id>。選択式。圃場が多くても一覧を押し出さない）。絞り込みの圃場の一覧と今週見る株は Promise.all で並べて取る（直列の往復 1 回）。
// searchParams は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
export default function WeeklyPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  return (
    <AppScreen title="今週見る株" backHref="/" backLabel="ホーム" current="home">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground">前回の葉数の観測から</p>
        <WeeklyThresholdToggle />
      </div>
      <Suspense fallback={<LoadingText />}>
        <WeeklyAll searchParams={searchParams} />
      </Suspense>
    </AppScreen>
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function WeeklyAll({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const query = await searchParams;
  const raw = typeof query.field === "string" ? query.field : undefined;
  const fieldId = raw && UUID_RE.test(raw) ? raw : undefined;
  const supabase = await createClient();
  const [{ rows, error }, { data: fields }] = await Promise.all([
    fetchWeeklyRows(fieldId),
    supabase.from("fields").select("id, name").order("name"),
  ]);

  return (
    <>
      <WeeklyFieldFilter fields={fields ?? []} current={fieldId} />
      {error ? (
        <p role="alert" className="text-destructive">
          今週見る株を取得できませんでした（{error}）
        </p>
      ) : (
        <WeeklyList rows={rows} />
      )}
    </>
  );
}
