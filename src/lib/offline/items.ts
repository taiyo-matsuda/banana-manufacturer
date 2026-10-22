// outbox 項目の組み立て（純粋関数）。id・時刻は呼び出し側が渡す（画面では crypto.randomUUID() と new Date()）。
import type { EventPayload, ObservationPayload, OutboxItem, PhotoPayload } from "./types";

type Base = { id: string; createdAt: Date };

function base(args: Base, stemId: string) {
  return {
    id: args.id,
    stem_id: stemId,
    created_at: args.createdAt.toISOString(),
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
    needs_attention: 0 as const,
  };
}

export function newObservationItem(
  args: Base & {
    stemId: string;
    type: ObservationPayload["type"];
    value: number;
    observedAt: Date;
    userId: string;
  },
): OutboxItem {
  return {
    ...base(args, args.stemId),
    kind: "observation",
    payload: {
      id: args.id,
      stem_id: args.stemId,
      type: args.type,
      value: args.value,
      observed_at: args.observedAt.toISOString(),
      observed_by: args.userId,
    },
  };
}

// 枯葉処理: events に直接追記する
export function newLeavesRemovedItem(
  args: Base & { stemId: string; count: number; occurredAt: Date; userId: string },
): OutboxItem {
  const payload: EventPayload = {
    method: "insert",
    id: args.id,
    type: "leaves_removed",
    target_type: "stem",
    target_id: args.stemId,
    occurred_at: args.occurredAt.toISOString(),
    recorded_by: args.userId,
    payload: { count: args.count },
  };
  return { ...base(args, args.stemId), kind: "event", payload };
}

// 出蕾・段数・袋掛け・摘蕾・収穫・被害: RPC record_stem_event（状態の更新を伴う）
export function newStemEventItem(
  args: Base & {
    stemId: string;
    type: Extract<EventPayload, { method: "record_stem_event" }>["type"];
    occurredAt: string; // ISO（occurredAtFromDate の結果）
    payload: Record<string, unknown>;
  },
): OutboxItem {
  const payload: EventPayload = {
    method: "record_stem_event",
    id: args.id,
    stem_id: args.stemId,
    type: args.type,
    occurred_at: args.occurredAt,
    payload: args.payload,
    note: null,
  };
  return { ...base(args, args.stemId), kind: "event", payload };
}

export function newPhotoItem(
  args: Base & {
    stemId: string;
    storagePath: string;
    contentType: string;
    takenAt: Date;
    userId: string;
    lat: number | null;
    lng: number | null;
    kind: string;
  },
): OutboxItem {
  const payload: PhotoPayload = {
    id: args.id,
    target_type: "stem",
    target_id: args.stemId,
    storage_path: args.storagePath,
    content_type: args.contentType,
    taken_at: args.takenAt.toISOString(),
    taken_by: args.userId,
    lat: args.lat,
    lng: args.lng,
    kind: args.kind,
    uploaded: false,
  };
  return { ...base(args, args.stemId), kind: "photo", payload };
}

// 同期状態画面の表示用
export function outboxItemLabel(item: OutboxItem): string {
  switch (item.kind) {
    case "observation":
      return { leaves_new: "新葉", leaves_current: "現在の葉数", pseudostem_girth_cm: "偽茎周囲長", height_cm: "高さ" }[item.payload.type];
    case "event":
      return (
        {
          leaves_removed: "枯葉処理",
          bud_emerged: "出蕾",
          hands_counted: "段数",
          bagged: "袋掛け",
          debudded: "摘蕾",
          harvested: "収穫",
          damage: "被害",
        } as Record<string, string>
      )[item.payload.type] ?? item.payload.type;
    case "photo":
      return "写真";
  }
}
