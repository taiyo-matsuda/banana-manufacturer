import { AppScreen } from "@/components/app/app-screen";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// 画面 7「予測一覧」のプレースホルダー（UX-1）。中身はステップ 3（気象取り込み・積算温度・収穫予測日）で作る。
export default function ForecastPage() {
  return (
    <AppScreen title="予測" current="forecast">
      <Card data-testid="forecast-placeholder">
        <CardHeader>
          <CardTitle>準備中</CardTitle>
          <CardDescription>
            収穫時期と収穫量の予測は、気象データの取り込みと積算温度の計算（ステップ 3）のあとで表示します。
          </CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground">
          いまは出蕾・袋掛け・収穫などの事実を茎の記録入力から残してください。予測はその記録から計算します。
        </CardContent>
      </Card>
    </AppScreen>
  );
}
