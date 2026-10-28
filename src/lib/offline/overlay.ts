// 画面への重ね合わせ（純粋関数）: サーバーから取得した観測・イベント・写真に、outbox の未送信分を重ねる。
//
// - 同じ id がサーバーにもあれば（同期済みで画面がまだ古い）未送信分は重ねない
// - 未送信の行は pending=true（履歴に「未同期」の印）
// - 茎の状態は、未送信の茎イベント（出蕾 → flowered、収穫 → harvested、被害 lost → lost）を created_at 順に適用した
//   「見かけの状態」にする。記録ボタンの出し分け（canRecordLeaves / canRecordEvent）はこの状態で判定する
import { nextStatus, todayJst } from "../stemEvents";
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

// --- 株の詳細への重ね合わせ（2-1） ------------------------------------------------
//
// 株の詳細の茎一覧（サーバーの茎と、その葉の観測）に、outbox の未送信分を重ねる:
// - 未送信の吸芽（record_sucker_emerged）は、その sucker_stem_id の茎がサーバーに無ければ status=sucker・pending=true の茎として足す
//   （generation=親+1、started_at=occurred_at の日本時間の日付、initial_leaf_count=0。RPC と同じ）
// - 未送信の観測は、その茎の observations に足す（累計葉数・吸芽の parent_cumulative_leaves・前回訪問日の既定値に効く）
// - 未送信の茎イベント（出蕾など）は、その茎の見かけの状態に反映する（吸芽の親茎の候補の判定に効く）

export type MatStemObservation = { id: string; type: string; value: number; observed_at: string; pending?: boolean };

export type MatStemRow = {
  id: string;
  generation: number;
  status: string;
  started_at: string;
  initial_leaf_count: number;
  parent_stem_id: string | null;
  observations: MatStemObservation[];
  pending?: boolean; // 未同期の吸芽（サーバーにまだ無い茎）
  // 3-3: 収穫予測日（estimates の最新。出蕾済みの茎だけ）。オフラインの殻（キャッシュ）には無い
  harvest?: { valueDate: string | null; needsReview: boolean } | null;
  // 3-5a: 検算（茎一覧の警告）に使う枯葉処理（現在の値）。未送信分も重ねる
  leaves_removed?: MatStemLeavesRemoved[];
};

export type MatStemLeavesRemoved = { id: string; count: number; occurred_at: string; pending?: boolean };

export function applyOutboxToMat(stems: readonly MatStemRow[], items: readonly OutboxItem[]): MatStemRow[] {
  const result: MatStemRow[] = stems.map((s) => ({
    ...s,
    observations: s.observations.map((o) => ({ ...o })),
    leaves_removed: (s.leaves_removed ?? []).map((r) => ({ ...r })),
  }));
  const byId = new Map(result.map((s) => [s.id, s]));
  const knownObs = new Set(result.flatMap((s) => s.observations.map((o) => o.id)));
  const knownRemoved = new Set(result.flatMap((s) => (s.leaves_removed ?? []).map((r) => r.id)));
  const sorted = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

  for (const item of sorted) {
    const stem = byId.get(item.stem_id);
    if (!stem) continue;
    if (item.kind === "observation") {
      if (knownObs.has(item.payload.id)) continue;
      knownObs.add(item.payload.id);
      stem.observations.push({
        id: item.payload.id,
        type: item.payload.type,
        value: item.payload.value,
        observed_at: item.payload.observed_at,
        pending: true,
      });
    } else if (item.kind === "event") {
      const p = item.payload;
      if (p.method === "insert" && p.type === "leaves_removed") {
        // 3-5a: 未送信の枯葉処理（検算に足す）
        const count = Number(p.payload?.count);
        if (knownRemoved.has(p.id) || !Number.isFinite(count)) continue;
        knownRemoved.add(p.id);
        stem.leaves_removed = [...(stem.leaves_removed ?? []), { id: p.id, count, occurred_at: p.occurred_at, pending: true }];
      } else if (p.method === "record_stem_event" || p.method === "remove_sucker") {
        stem.status = nextStatus(stem.status, p.type, p.payload) ?? stem.status;
      } else if (p.method === "adopt_sucker") {
        // 2-2: 採用は状態（active）と初期葉数（累計葉数の起点）を重ねる。既に吸芽でなければ（同期済み）何もしない
        const next = nextStatus(stem.status, p.type, p.payload);
        if (next !== null) {
          stem.status = next;
          stem.initial_leaf_count = p.payload.initial_leaf_count;
        }
      } else if (p.method === "record_sucker_emerged") {
        if (byId.has(p.sucker_stem_id)) continue;
        const sucker: MatStemRow = {
          id: p.sucker_stem_id,
          generation: stem.generation + 1,
          status: "sucker",
          started_at: todayJst(new Date(p.occurred_at)),
          initial_leaf_count: 0,
          parent_stem_id: stem.id,
          observations: [],
          pending: true,
        };
        result.push(sucker);
        byId.set(sucker.id, sucker);
      }
    }
  }
  return result;
}

// 株の詳細で、送信済みで outbox から消えたがサーバーの props にまだ無い項目を保持するときの鍵。
// 観測は観測の id、吸芽は吸芽の茎の id（株の詳細が持つのは茎と観測なので）、枯葉処理はイベントの id（3-5a、検算）。
// 吸芽の採用・芽かき（2-2）は matSettledKey（その茎がサーバーで吸芽でなくなったら serverIds に入る鍵）。
// それ以外は保持しない（null）
export function matHoldKey(item: OutboxItem): string | null {
  if (item.kind === "observation") return item.payload.id;
  if (item.kind === "event" && item.payload.method === "insert" && item.payload.type === "leaves_removed") return item.payload.id;
  if (item.kind === "event" && item.payload.method === "record_sucker_emerged") return item.payload.sucker_stem_id;
  if (item.kind === "event" && (item.payload.method === "adopt_sucker" || item.payload.method === "remove_sucker")) {
    return matSettledKey(item.payload.stem_id);
  }
  return null;
}

// 吸芽の行き先が決まった（サーバーの状態が sucker でなくなった）茎の鍵。株の詳細は serverIds にこれも入れる
export function matSettledKey(stemId: string): string {
  return `${stemId}:settled`;
}

// 株の詳細の serverIds（matHoldKey と対になる）: 茎の id、観測の id、吸芽でない茎の matSettledKey
export function matServerIds(stems: readonly MatStemRow[]): Set<string> {
  const ids = new Set<string>();
  for (const s of stems) {
    ids.add(s.id);
    if (s.status !== "sucker") ids.add(matSettledKey(s.id));
    for (const o of s.observations) ids.add(o.id);
    for (const r of s.leaves_removed ?? []) ids.add(r.id);
  }
  return ids;
}
