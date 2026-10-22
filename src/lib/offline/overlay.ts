// 画面への重ね合わせ（純粋関数）: サーバーから取得した観測・イベント・写真に、outbox の未送信分を重ねる。
//
// - 同じ id がサーバーにもあれば（同期済みで画面がまだ古い）未送信分は重ねない
// - 未送信の行は pending=true（履歴に「未同期」の印）
// - 茎の状態は、未送信の茎イベント（出蕾 → flowered、収穫 → harvested、被害 lost → lost）を created_at 順に適用した
//   「見かけの状態」にする。記録ボタンの出し分け（canRecordLeaves / canRecordEvent）はこの状態で判定する
import { nextStatus } from "../stemEvents";
import type { EventRow, ObservationRow, PhotoRow } from "../stems/records";
import type { OutboxItem } from "./types";

export type OverlayServer = {
  status: string;
  observations: readonly ObservationRow[];
  events: readonly EventRow[];
  photos: readonly PhotoRow[];
};

export type OverlayResult = {
  status: string; // 未送信のイベントを反映した見かけの状態
  observations: ObservationRow[];
  events: EventRow[];
  photos: PhotoRow[];
  pendingCount: number; // この茎の未送信件数（重ねた数）
};

// 未送信分のうち、この茎のものだけを created_at 順に
export function itemsForStem(items: readonly OutboxItem[], stemId: string): OutboxItem[] {
  return items
    .filter((i) => i.stem_id === stemId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export function applyOutbox(
  server: OverlayServer,
  items: readonly OutboxItem[],
  stemId: string,
  photoUrls: Readonly<Record<string, string>> = {},
): OverlayResult {
  const observations = server.observations.map((o) => ({ ...o }));
  const events = server.events.map((e) => ({ ...e }));
  const photos = server.photos.map((p) => ({ ...p }));
  const known = new Set<string>([...observations.map((o) => o.id), ...events.map((e) => e.id), ...photos.map((p) => p.id)]);
  let status = server.status;
  let pendingCount = 0;

  for (const item of itemsForStem(items, stemId)) {
    if (known.has(item.id)) continue;
    known.add(item.id);
    pendingCount += 1;
    switch (item.kind) {
      case "observation":
        observations.push({
          id: item.payload.id,
          type: item.payload.type,
          value: item.payload.value,
          observed_at: item.payload.observed_at,
          superseded_by: null,
          observer_name: null,
          pending: true,
        });
        break;
      case "event": {
        const p = item.payload;
        if (p.method === "insert") {
          events.push({
            id: p.id,
            type: p.type,
            occurred_at: p.occurred_at,
            payload: p.payload,
            superseded_by: null,
            recorder_name: null,
            pending: true,
          });
        } else {
          events.push({
            id: p.id,
            type: p.type,
            occurred_at: p.occurred_at,
            payload: p.payload,
            superseded_by: null,
            recorder_name: null,
            pending: true,
          });
          status = nextStatus(status, p.type, p.payload) ?? status;
        }
        break;
      }
      case "photo":
        photos.push({
          id: item.payload.id,
          kind: item.payload.kind,
          taken_at: item.payload.taken_at,
          url: photoUrls[item.payload.id] ?? null,
          taker_name: null,
          pending: true,
        });
        break;
    }
  }
  return { status, observations, events, photos, pendingCount };
}
