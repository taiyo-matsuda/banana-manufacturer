"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { budLeafSnapshot } from "@/lib/corrections";
import { getDb } from "@/lib/db";
import { cumulativeLeaves, cumulativeLeavesByCheck, leafCheckWarning } from "@/lib/leaves";
import { applyOutbox } from "@/lib/offline/overlay";
import type { OutboxItem, PendingPhoto } from "@/lib/offline/types";
import { useHeldItems } from "@/lib/offline/use-held-items";
import { useLiveQuery, useOutboxForStem } from "@/lib/offline/use-live-query";
import { buildHistory, canRecordLeaves, toLeafObservations, toLeavesRemoved } from "@/lib/stems/records";
import { stemStatusLabel } from "@/lib/stems/status";
import { latestDateJst } from "@/lib/stemEvents";
import { EventRecord } from "./event-record";
import { LeafRecord } from "./leaf-record";
import type { StemView } from "./load";
import { PhotoCapture } from "./photo-capture";
import { StemHeader } from "./stem-header";
import { StemHistory } from "./stem-history";

// 画面 4「茎の記録入力」の本体（1-9）。サーバーから取得した観測・イベント・写真（props）に、端末の outbox にある
// この茎の未送信分を重ねて表示する（累計葉数・検算・履歴・見かけの状態・記録ボタンの可否）。
// 記録は outbox に積むだけ（enqueue）。同期が終わると SyncStatus が router.refresh() し、props がサーバーの最新になる。
// 送信済みで outbox から消えたが props にまだ無い行は、props に現れるまで手元に保持する（一瞬消えて見えないように）。
export function StemRecordClient({ stem }: { stem: StemView }) {
  const pending = useOutboxForStem(stem.id);
  const serverIds = useMemo(
    () => new Set<string>([...stem.observations.map((o) => o.id), ...stem.events.map((e) => e.id), ...stem.photos.map((p) => p.id)]),
    [stem.observations, stem.events, stem.photos],
  );
  const held = useHeldItems(pending, serverIds);
  const items = useMemo(() => [...pending, ...held], [pending, held]);
  const photoUrls = usePendingPhotoUrls(items);

  const view = useMemo<StemView>(() => {
    const overlay = applyOutbox(
      { status: stem.status, observations: stem.observations, events: stem.events, photos: stem.photos },
      items,
      stem.id,
      photoUrls,
    );
    const leafObs = toLeafObservations(overlay.observations);
    const cumulative = cumulativeLeaves(stem.initialLeafCount, leafObs);
    const byCheck = cumulativeLeavesByCheck(leafObs, toLeavesRemoved(overlay.events));
    return {
      ...stem,
      status: overlay.status,
      cumulative,
      byCheck,
      checkWarning: leafCheckWarning(cumulative, byCheck),
      canRecord: canRecordLeaves(overlay.status),
      latestObservedOn: latestDateJst(overlay.observations.filter((o) => o.superseded_by === null).map((o) => o.observed_at)),
      budSnapshot: budLeafSnapshot(stem.initialLeafCount, overlay.observations, overlay.events),
      history: buildHistory(overlay.observations, overlay.events, overlay.photos),
      observations: overlay.observations,
      events: overlay.events,
      photos: overlay.photos,
    };
  }, [stem, items, photoUrls]);

  return (
    <article className="flex flex-col gap-4" data-testid="stem-record" data-pending-count={items.length}>
      <StemHeader stem={view} />

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

// 未送信の写真の Blob（pendingPhotos）を object URL にして履歴のサムネイルに使う。変わったら前の URL を revoke する
function usePendingPhotoUrls(items: OutboxItem[]): Record<string, string> {
  const photoIds = useMemo(() => items.filter((i) => i.kind === "photo").map((i) => i.id), [items]);
  const key = photoIds.join(",");
  const blobs = useLiveQuery<PendingPhoto[]>(
    () => (photoIds.length === 0 ? Promise.resolve([]) : getDb().pendingPhotos.where("id").anyOf(photoIds).toArray()),
    [key],
    [],
  );
  // Blob はアップロード成功後に消えるが、サーバーの行（署名付き URL）が props に来るまでは URL を残す
  // （履歴の写真が一瞬「画像なし」にならないように）。id が items から消えたときに revoke する
  const urlsRef = useRef<Map<string, string>>(new Map());
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let changed = false;
    for (const b of blobs) {
      if (!urlsRef.current.has(b.id)) {
        urlsRef.current.set(b.id, URL.createObjectURL(b.blob));
        changed = true;
      }
    }
    const keep = new Set(photoIds);
    for (const [id, url] of urlsRef.current) {
      if (!keep.has(id)) {
        URL.revokeObjectURL(url);
        urlsRef.current.delete(id);
        changed = true;
      }
    }
    if (changed) setUrls(Object.fromEntries(urlsRef.current));
  }, [blobs, photoIds]);
  useEffect(() => {
    const map = urlsRef.current;
    return () => {
      for (const url of map.values()) URL.revokeObjectURL(url);
      map.clear();
    };
  }, []);
  return urls;
}
