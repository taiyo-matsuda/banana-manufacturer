"use client";

import { useState } from "react";
import type { OutboxItem } from "./types";

const byItemId = (item: OutboxItem): string | null => item.id;

// outbox から消えた（送信済み）がサーバーの props にまだ無い項目を、props に現れるまで保持する（一瞬消えて見えないように）。
// keyOf は「サーバーの props にこの項目が現れたか」を serverIds で調べる鍵（null は保持しない）。既定は項目の id。
// keyOf はモジュールの関数など、描画のたびに変わらないものを渡す。
// （props / 購読結果が変わったときに描画中に state を調整する、React の「adjusting state when a prop changes」の形）
export function useHeldItems(
  pending: OutboxItem[],
  serverIds: Set<string>,
  keyOf: (item: OutboxItem) => string | null = byItemId,
): OutboxItem[] {
  const [tracked, setTracked] = useState<{ pending: OutboxItem[]; serverIds: Set<string>; held: OutboxItem[] }>({
    pending,
    serverIds,
    held: [],
  });
  if (tracked.pending !== pending || tracked.serverIds !== serverIds) {
    const pendingIds = new Set(pending.map((i) => i.id));
    const next = new Map<string, OutboxItem>();
    for (const i of [...tracked.held, ...tracked.pending]) {
      const key = keyOf(i);
      if (key !== null && !pendingIds.has(i.id) && !serverIds.has(key)) next.set(i.id, i);
    }
    setTracked({ pending, serverIds, held: [...next.values()] });
  }
  return tracked.held;
}
