"use client";

// 画面からの記録（ブラウザ側）: 端末で id を採番 → Dexie の outbox（写真は pendingPhotos も）に書く → 同期を起動する。
// オンラインでも同じ経路（offline-sync.md 1 章）。書き込みは Dexie への put だけなので圏外でも成功する。
import { getDb } from "../db";
import { newLeavesRemovedItem, newObservationItem, newPhotoItem, newStemEventItem } from "./items";
import { requestSync } from "./sync-client";
import type { ObservationPayload, OutboxItem, StemEventRpcPayload } from "./types";

const newId = () => crypto.randomUUID();

async function enqueue(items: OutboxItem[]) {
  const db = getDb();
  await db.outbox.bulkAdd(items);
  void requestSync();
}

export async function enqueueObservation(args: { stemId: string; type: ObservationPayload["type"]; value: number; observedAt?: Date; userId: string }) {
  const now = new Date();
  const item = newObservationItem({ id: newId(), createdAt: now, observedAt: args.observedAt ?? now, ...args });
  await enqueue([item]);
  return item;
}

export async function enqueueLeavesRemoved(args: { stemId: string; count: number; userId: string }) {
  const now = new Date();
  const item = newLeavesRemovedItem({ id: newId(), createdAt: now, occurredAt: now, ...args });
  await enqueue([item]);
  return item;
}

// 茎のイベント（RPC）。出蕾は生葉数・周囲長の観測 2 行を別項目として同時に積む（同じ occurred_at）
export async function enqueueStemEvent(args: {
  stemId: string;
  type: StemEventRpcPayload["type"];
  occurredAt: string; // ISO
  payload: Record<string, unknown>;
  userId: string;
}) {
  const now = new Date();
  const items: OutboxItem[] = [newStemEventItem({ id: newId(), createdAt: now, ...args })];
  if (args.type === "bud_emerged") {
    const observedAt = new Date(args.occurredAt);
    // created_at をイベントより後にする（送る順）
    const later = new Date(now.getTime() + 1);
    items.push(
      newObservationItem({ id: newId(), createdAt: later, stemId: args.stemId, type: "leaves_current", value: args.payload.leaves_current as number, observedAt, userId: args.userId }),
      newObservationItem({ id: newId(), createdAt: new Date(now.getTime() + 2), stemId: args.stemId, type: "pseudostem_girth_cm", value: args.payload.girth_cm as number, observedAt, userId: args.userId }),
    );
  }
  await enqueue(items);
  return items[0];
}

export async function enqueuePhoto(args: {
  id: string;
  stemId: string;
  storagePath: string;
  blob: Blob;
  contentType: string;
  takenAt: Date;
  userId: string;
  lat: number | null;
  lng: number | null;
  kind: string;
}) {
  const db = getDb();
  const item = newPhotoItem({ createdAt: new Date(), ...args });
  await db.transaction("rw", db.outbox, db.pendingPhotos, async () => {
    await db.pendingPhotos.put({ id: args.id, blob: args.blob, content_type: args.contentType });
    await db.outbox.add(item);
  });
  void requestSync();
  return item;
}
