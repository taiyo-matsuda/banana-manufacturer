import { NeedsReviewBadge } from "@/components/app/needs-review-badge";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMonthDay, type HarvestDisplay, harvestSummary, unavailableMessage } from "@/lib/prediction/harvest";
import { jstDateOf } from "@/lib/weather/dates";

// 茎の画面の「収穫予測」（3-3、prediction.md 2・7 章）: 「収穫予測: ◯月◯日ごろ（◯日〜◯日）」。
// - harvest はサーバー（load.ts）が読んだ estimates の最新。出蕾済み（flowered）の茎だけに出す（lost・収穫済み・出蕾前は出さない）
// - severe の被害（茎・その株・その圃場）があれば「要確認」
// - 平年値が足りない等で予測できなかったときは理由
// - "offline": オフラインの殻（2-9）。推定はキャッシュしないので、出蕾済みなら理由だけ出す
export type StemHarvestProp = HarvestDisplay | null | "offline";

export function StemHarvestSection({ harvest, flowered }: { harvest: StemHarvestProp; flowered: boolean }) {
  if (!flowered || harvest === null) return null;
  if (harvest === "offline") {
    return (
      <Card data-testid="stem-harvest" data-state="offline">
        <CardHeader>
          <CardTitle>収穫予測</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground" data-testid="stem-harvest-offline">
            オフラインでは収穫予測を表示できません（電波のある所で開き直すと出ます）
          </p>
        </CardContent>
      </Card>
    );
  }
  const review = harvest.needsReview ? <NeedsReviewBadge data-testid="stem-harvest-review" /> : null;
  return (
    <Card
      data-testid="stem-harvest"
      data-state={harvest.state}
      data-needs-review={harvest.needsReview ? "true" : "false"}
      data-value-date={harvest.state === "ok" ? harvest.valueDate : undefined}
      data-lower-date={harvest.state === "ok" ? harvest.lowerDate : undefined}
      data-upper-date={harvest.state === "ok" ? harvest.upperDate : undefined}
    >
      <CardHeader>
        <CardTitle>収穫予測</CardTitle>
        {review && <CardAction>{review}</CardAction>}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {harvest.state === "ok" ? (
          <p className="text-lg font-semibold" data-testid="stem-harvest-summary">
            {harvestSummary(harvest)}
          </p>
        ) : (
          <p className="text-muted-foreground" data-testid="stem-harvest-unavailable">
            {unavailableMessage(harvest.reason, harvest.date)}
          </p>
        )}
        {harvest.needsReview && (
          <p className="text-sm text-muted-foreground" data-testid="stem-harvest-review-note">
            大きな被害（程度: 重）の記録があります。予測どおりに育つか確かめてください
          </p>
        )}
        <p className="text-sm text-muted-foreground" data-testid="stem-harvest-computed">
          {formatMonthDay(jstDateOf(harvest.computedAt))} 計算（積算温度と平年値から。目標の ±10% の幅）
        </p>
      </CardContent>
    </Card>
  );
}
