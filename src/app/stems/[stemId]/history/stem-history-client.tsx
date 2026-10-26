"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StemView } from "@/lib/stems/view";
import { StemHeader } from "../stem-header";
import { StemHistory } from "../stem-history";
import { useStemOverlay } from "../use-stem-overlay";

// 画面 8「茎の履歴」の本体。記録入力画面と同じ一覧に、端末の outbox の未送信分を「未同期」の印付きで重ねる
// （2-9、offline-sync.md 5.6）。オンライン（RSC の props）でもオフラインの殻（端末のキャッシュ）でも同じ部品で描く
export function StemHistoryClient({ stem }: { stem: StemView }) {
  const { view, pendingCount } = useStemOverlay(stem);
  return (
    <>
      <StemHeader stem={view} />
      <div className="flex gap-3">
        <Button asChild variant="outline" className="flex-1">
          <Link href={`/stems/${stem.id}`} data-testid="stem-record-link">
            記録入力へ
          </Link>
        </Button>
        <Button asChild variant="outline" className="flex-1">
          <Link href={`/mats/${stem.mat.id}`} data-testid="stem-mat-link">
            株 {stem.mat.code} へ
          </Link>
        </Button>
      </div>
      <Card data-testid="stem-history-card" data-pending-count={pendingCount}>
        <CardHeader>
          <CardTitle>履歴</CardTitle>
        </CardHeader>
        <CardContent>
          <StemHistory entries={view.history} correctable />
        </CardContent>
      </Card>
    </>
  );
}
