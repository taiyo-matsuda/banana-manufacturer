"use client";

import { liveQuery } from "dexie";
import { useEffect, useState } from "react";
import { getDb, hasIndexedDb } from "../db";
import type { OutboxItem } from "./types";

// Dexie の liveQuery を購読する小さなフック。SSR では購読しない（初期値のまま）。
// deps が変わると購読し直す。querier の中で Dexie のテーブルを読むと、その変更で再実行される
export function useLiveQuery<T>(querier: () => Promise<T>, deps: readonly unknown[], initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    if (!hasIndexedDb()) return;
    const sub = liveQuery(querier).subscribe({
      next: (v) => setValue(v),
      error: (err) => console.error("liveQuery failed", err),
    });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- querier は deps で表す
  }, deps);
  return value;
}

// outbox 全体（created_at 順）。null は未読込（SSR / 初回描画）
export function useOutbox(): OutboxItem[] | null {
  return useLiveQuery<OutboxItem[] | null>(() => getDb().outbox.orderBy("created_at").toArray(), [], null);
}

// ある茎の未送信分
export function useOutboxForStem(stemId: string): OutboxItem[] {
  return useLiveQuery<OutboxItem[]>(() => getDb().outbox.where("stem_id").equals(stemId).sortBy("created_at"), [stemId], []);
}
