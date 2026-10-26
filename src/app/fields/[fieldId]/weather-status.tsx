import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { weatherStatusView, type WeatherSyncStatusRow } from "@/lib/weather/status";
import { createClient } from "@/lib/supabase/server";
import { WEATHER_SOURCE } from "@/lib/weather/sync";
import { WeatherSyncButton } from "./weather-sync-button";

// 圃場の詳細の「気温」（3-1）: 最終取得の日時と件数、失敗していれば理由、未取得なら「取り込み待ち」。
// 保存済みの日別の行数と最も古い日も出す。「今すぐ取り込む」で日次と同じ取り込みを 1 圃場だけ走らせる。
// オフラインの殻（2-9）には出さない（field-detail-view.tsx の外。サーバーで読む）。
export async function WeatherStatusSection({ fieldId }: { fieldId: string }) {
  const supabase = await createClient();
  const [{ data: status }, { count }, { data: oldest }] = await Promise.all([
    supabase
      .from("weather_sync_status")
      .select("last_run_at, last_days, last_error, last_success_at, last_success_days")
      .eq("field_id", fieldId)
      .maybeSingle(),
    supabase
      .from("weather_daily")
      .select("date", { count: "exact", head: true })
      .eq("field_id", fieldId)
      .eq("source", WEATHER_SOURCE),
    supabase
      .from("weather_daily")
      .select("date")
      .eq("field_id", fieldId)
      .eq("source", WEATHER_SOURCE)
      .order("date", { ascending: true })
      .limit(1),
  ]);
  const view = weatherStatusView((status as WeatherSyncStatusRow | null) ?? null);
  const firstDate = (oldest?.[0]?.date as string | undefined) ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>気温</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p data-testid="weather-status" data-state={view.state}>
            {view.text}
          </p>
          {count !== null && count > 0 && (
            <p className="text-sm text-muted-foreground" data-testid="weather-stored">
              保存済み {count.toLocaleString("ja-JP")}日分{firstDate ? `（${firstDate}〜）` : ""}
            </p>
          )}
        </div>
        {view.state === "error" && (
          <Alert variant="destructive" data-testid="weather-error">
            <AlertDescription>
              {view.errorAt} の取り込みで失敗: {view.error}。次回の取り込みで埋め直します
            </AlertDescription>
          </Alert>
        )}
        <WeatherSyncButton fieldId={fieldId} />
      </CardContent>
    </Card>
  );
}
