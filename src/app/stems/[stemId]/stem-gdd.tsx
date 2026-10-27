import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTempC, type StemGdd } from "@/lib/gdd";

// 茎の画面の「積算温度」（3-2、prediction.md 1 章）: 出蕾済みの茎に「出蕾から N 日、積算温度 X ℃・日」（実績のみ。予測は 3-3）。
// - gdd はサーバー（load.ts の loadStemRecord）で計算した値。出蕾前の茎は null で、何も出さない
// - "offline": オフラインの殻（2-9）。気温はキャッシュしないので、出蕾済みなら理由だけ出す
export type StemGddProp = StemGdd | null | "offline";

export function StemGddSection({ gdd, budEmerged }: { gdd: StemGddProp; budEmerged: boolean }) {
  if (gdd === null) return null;
  if (gdd === "offline") {
    if (!budEmerged) return null;
    return (
      <Card data-testid="stem-gdd" data-state="offline">
        <CardHeader>
          <CardTitle>積算温度</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground" data-testid="stem-gdd-offline">
            オフラインでは積算温度を表示できません（電波のある所で開き直すと出ます）
          </p>
        </CardContent>
      </Card>
    );
  }
  if (gdd.notImported) {
    return (
      <Card data-testid="stem-gdd" data-state="not-imported">
        <CardHeader>
          <CardTitle>積算温度</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground" data-testid="stem-gdd-not-imported">
            気温がまだ取り込まれていません（圃場の詳細で最終取得を確認）
          </p>
        </CardContent>
      </Card>
    );
  }
  const until = gdd.ended === "harvested" ? "収穫まで " : gdd.ended === "ended" ? "終了まで " : "";
  return (
    <Card data-testid="stem-gdd" data-state="ok" data-total={gdd.total} data-base-temp={gdd.baseTempC}>
      <CardHeader>
        <CardTitle>積算温度</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p className="text-lg" data-testid="stem-gdd-summary">
          出蕾から{until}{" "}
          <span className="font-semibold tabular-nums" data-testid="stem-gdd-days">
            {gdd.elapsedDays}
          </span>{" "}
          日、積算温度{" "}
          <span className="text-2xl font-semibold tabular-nums" data-testid="stem-gdd-total">
            {gdd.rounded.toLocaleString("ja-JP")}
          </span>{" "}
          ℃・日
        </p>
        <p className="text-sm text-muted-foreground" data-testid="stem-gdd-base">
          基準 {formatTempC(gdd.baseTempC)}℃（{gdd.budDate} 出蕾
          {gdd.accumulatedTo > gdd.budDate ? `、${gdd.accumulatedTo} までの気温` : "。積算は翌日の気温から"}）
        </p>
        {gdd.missingDays > 0 && (
          <Alert variant="warning" data-testid="stem-gdd-missing">
            <AlertDescription>気温が欠けている日が {gdd.missingDays} 日あります（その日は積算に入っていません）</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
