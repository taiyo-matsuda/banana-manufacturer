import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { RecommendationParamsForm } from "./recommendation-params-form";

// 圃場の詳細の「提案の設定」（3-4、prediction.md 6 章）: 袋掛け・摘蕾の提案を出す日数 N（出蕾から）と、収穫期の提案を出す日数
// （収穫予測の早い日の何日前から）の圃場ごとの値（field_recommendation_params）。空欄なら暫定の既定値（14 日・7 日）。
// オフラインの殻（2-9）には出さない（field-detail-view.tsx の外。サーバーで読む）。
export async function RecommendationSettingsSection({ fieldId }: { fieldId: string }) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("field_recommendation_params")
    .select("bag_after_days, harvest_window_days")
    .eq("field_id", fieldId)
    .maybeSingle();
  const text = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

  return (
    <Card data-testid="recommendation-settings">
      <CardHeader>
        <CardTitle>提案の設定</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>提案の設定を取得できませんでした（{error.message}）</AlertDescription>
          </Alert>
        ) : (
          <RecommendationParamsForm
            fieldId={fieldId}
            bagAfterDays={text(data?.bag_after_days as number | null | undefined)}
            harvestWindowDays={text(data?.harvest_window_days as number | null | undefined)}
          />
        )}
      </CardContent>
    </Card>
  );
}
