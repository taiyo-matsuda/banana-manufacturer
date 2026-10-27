import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTempC } from "@/lib/gdd";
import { paramToInput } from "@/lib/fields/prediction-params";
import { createClient } from "@/lib/supabase/server";
import { PredictionParamsForm } from "./prediction-params-form";

// 圃場の詳細の「予測の設定」（3-2）: 品種ごとに、基準温度（積算温度の計算に使う）と目標積算温度（出蕾→収穫。使うのは 3-3）の
// 圃場 × 品種の上書き（field_cultivar_params）。空欄なら品種の既定（cultivars）。
// オフラインの殻（2-9）には出さない（field-detail-view.tsx の外。サーバーで読む）。
export async function PredictionSettingsSection({ fieldId }: { fieldId: string }) {
  const supabase = await createClient();
  const [{ data: cultivars, error: cultivarsError }, { data: params, error: paramsError }] = await Promise.all([
    supabase.from("cultivars").select("id, name, base_temp_c, flowering_to_harvest_gdd").order("name"),
    supabase.from("field_cultivar_params").select("cultivar_id, base_temp_c, flowering_to_harvest_gdd").eq("field_id", fieldId),
  ]);
  const error = cultivarsError?.message ?? paramsError?.message ?? null;
  const byCultivar = new Map((params ?? []).map((p) => [p.cultivar_id as string, p]));

  return (
    <Card data-testid="prediction-settings">
      <CardHeader>
        <CardTitle>予測の設定</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <p className="text-sm text-muted-foreground">
          品種ごとに、この圃場で使う値を変えられます。空欄なら品種の既定値を使います
        </p>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>予測の設定を取得できませんでした（{error}）</AlertDescription>
          </Alert>
        ) : (
          (cultivars ?? []).map((c) => {
            const p = byCultivar.get(c.id as string);
            return (
              <PredictionParamsForm
                key={c.id as string}
                fieldId={fieldId}
                cultivarId={c.id as string}
                cultivarName={c.name as string}
                defaultBaseTemp={formatTempC(Number(c.base_temp_c))}
                defaultTargetGdd={Number(c.flowering_to_harvest_gdd).toLocaleString("ja-JP")}
                baseTemp={paramToInput(p?.base_temp_c as number | string | null | undefined)}
                targetGdd={paramToInput(p?.flowering_to_harvest_gdd as number | string | null | undefined)}
              />
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
