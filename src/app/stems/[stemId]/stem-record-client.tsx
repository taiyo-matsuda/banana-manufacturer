"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { stemStatusLabel } from "@/lib/stems/status";
import type { StemView } from "@/lib/stems/view";
import { EventRecord } from "./event-record";
import { LeafRecord } from "./leaf-record";
import { PhotoCapture } from "./photo-capture";
import { StemGddSection, type StemGddProp } from "./stem-gdd";
import { StemHarvestSection, type StemHarvestProp } from "./stem-harvest";
import { StemHeader } from "./stem-header";
import { StemHistory } from "./stem-history";
import { useStemOverlay } from "./use-stem-overlay";

// 画面 4「茎の記録入力」の本体（1-9）。サーバーから取得した観測・イベント・写真（props）に、端末の outbox にある
// この茎の未送信分を重ねて表示する（累計葉数・検算・履歴・見かけの状態・記録ボタンの可否。use-stem-overlay.ts）。
// 記録は outbox に積むだけ（enqueue）。同期が終わると SyncStatus が router.refresh() し、props がサーバーの最新になる。
// オフラインの殻（2-9、src/app/offline-shell/）も、端末のキャッシュから組み立てた同じ形の stem でこれを描く。
// gdd: 3-2 の積算温度（サーバーで計算）。オフラインの殻は "offline"（気温はキャッシュしないので理由を出す）
// harvest: 3-3 の収穫予測（estimates の最新）。見かけの状態が出蕾済みのときだけ出す（未送信の喪失を重ねたら消える）。殻は "offline"
export function StemRecordClient({ stem, gdd, harvest }: { stem: StemView; gdd: StemGddProp; harvest: StemHarvestProp }) {
  const { view, pendingCount } = useStemOverlay(stem);

  return (
    <article className="flex flex-col gap-4" data-testid="stem-record" data-pending-count={pendingCount}>
      <StemHeader stem={view} />
      <StemHarvestSection harvest={harvest} flowered={view.status === "flowered"} />
      <StemGddSection
        gdd={gdd}
        budEmerged={view.events.some((e) => e.type === "bud_emerged" && e.superseded_by === null)}
      />

      {view.canRecord ? (
        <>
          <LeafRecord stemId={stem.id} userId={stem.userId} />
          <PhotoCapture stemId={stem.id} userId={stem.userId} organizationId={stem.organizationId} />
          <EventRecord
            stemId={stem.id}
            userId={stem.userId}
            status={view.status}
            cumulativeLeaves={view.cumulative}
            defaultEarliestAt={view.latestObservedOn}
          />
        </>
      ) : (
        <p className="text-muted-foreground" data-testid="record-closed">
          この茎は{stemStatusLabel(view.status)}のため記録できません。履歴だけ見られます
        </p>
      )}

      <Button asChild variant="outline">
        <Link href={`/mats/${stem.mat.id}`} data-testid="stem-mat-link">
          株 {stem.mat.code} へ
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>履歴</CardTitle>
          <CardAction>
            <Button asChild variant="link" size="sm" className="px-0">
              <Link href={`/stems/${stem.id}/history`} data-testid="stem-history-link">
                履歴を開く
              </Link>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <StemHistory entries={view.history} correctable />
        </CardContent>
      </Card>
    </article>
  );
}
