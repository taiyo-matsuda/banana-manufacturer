"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getDb } from "@/lib/db";
import { applyOutbox } from "@/lib/offline/overlay";
import type { OutboxItem, PendingPhoto } from "@/lib/offline/types";
import { useHeldItems } from "@/lib/offline/use-held-items";
import { useLiveQuery, useOutboxForStem } from "@/lib/offline/use-live-query";
import { buildStemView, type StemView } from "@/lib/stems/view";

// 茎の画面（記録入力・履歴）の表示データに、端末の outbox にあるこの茎の未送信分を重ねる（1-9。2-9 で履歴にも）。
// 入力の stem はサーバー（RSC の props）でもオフラインの殻（端末のキャッシュ）でもよい。
// 送信済みで outbox から消えたが stem にまだ無い行は、stem に現れるまで手元に保持する（一瞬消えて見えないように）。
// 戻り値の pendingCount は重ねた未送信の件数
export function useStemOverlay(stem: StemView): { view: StemView; pendingCount: number } {
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
    return buildStemView({
      id: stem.id,
      generation: stem.generation,
      status: overlay.status,
      initialLeafCount: stem.initialLeafCount,
      mat: stem.mat,
      userId: stem.userId,
      organizationId: stem.organizationId,
      observations: overlay.observations,
      events: overlay.events,
      photos: overlay.photos,
    });
  }, [stem, items, photoUrls]);

  return { view, pendingCount: items.length };
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
