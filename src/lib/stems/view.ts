// 茎の記録入力（画面 4）と履歴（画面 8）に渡すデータ（StemView）の組み立て。純粋関数。
// サーバー（src/app/stems/[stemId]/load.ts、RSC）とオフラインの殻（2-9、端末のキャッシュ）で共通に使う。
// 違うのはデータの取り方だけ（観測・イベント・写真の行をどこから持ってくるか）。
import { type BudLeafSnapshot, budLeafSnapshot } from "../corrections";
import { cumulativeLeaves, type LeafCheck, leafCheck, leafCheckWarning, type LeafObservation } from "../leaves";
import type { MatStemRow } from "../offline/overlay";
import { latestDateJst } from "../stemEvents";
import {
  buildHistory,
  canRecordLeaves,
  type EventRow,
  type HistoryEntry,
  type ObservationRow,
  type PhotoRow,
  toLeafObservations,
  toLeavesRemoved,
} from "./records";

export type StemView = {
  id: string;
  generation: number;
  status: string;
  initialLeafCount: number;
  mat: { id: string; code: string };
  cumulative: number;
  check: LeafCheck | null; // 検算（最新の現在の葉数を記録した時点で比べる。3-5a、leaves.ts）
  checkWarning: string | null;
  canRecord: boolean;
  latestObservedOn: string | null; // 直近の観測日（JST、YYYY-MM-DD。訂正済みを除く）。出蕾の「前回訪問日」の既定値
  budSnapshot: BudLeafSnapshot | null; // 2-6: 出蕾時の累計葉数（記録）と現在の観測からの計算
  history: HistoryEntry[];
  // 1-9: Client Component が outbox の未送信分を重ねるための生データと、記録に必要な id
  userId: string; // observed_by / recorded_by / taken_by
  organizationId: string; // 写真の Storage パス
  observations: ObservationRow[];
  events: EventRow[];
  photos: PhotoRow[];
};

export type StemViewInput = {
  id: string;
  generation: number;
  status: string;
  initialLeafCount: number;
  mat: { id: string; code: string };
  userId: string;
  organizationId: string;
  observations: ObservationRow[];
  events: EventRow[];
  photos: PhotoRow[];
};

// 観測・イベント・写真から、累計葉数・検算・履歴などを計算して StemView にする
export function buildStemView(input: StemViewInput): StemView {
  const { observations, events, photos, initialLeafCount } = input;
  const leafObs = toLeafObservations(observations);
  const cumulative = cumulativeLeaves(initialLeafCount, leafObs);
  const check = leafCheck(initialLeafCount, leafObs, toLeavesRemoved(events));
  return {
    ...input,
    cumulative,
    check,
    checkWarning: leafCheckWarning(check),
    canRecord: canRecordLeaves(input.status),
    latestObservedOn: latestDateJst(observations.filter((o) => o.superseded_by === null).map((o) => o.observed_at)),
    budSnapshot: budLeafSnapshot(initialLeafCount, observations, events),
    history: buildHistory(observations, events, photos),
  };
}

// 3-5a: 株の詳細の茎一覧の検算（茎の画面と同じ leaves.ts の式）。観測・枯葉処理は現在の値（と未送信分）が入っている。
// 吸芽（採用前）は葉を数え始めていないので null
export function matStemLeafCheck(stem: MatStemRow): LeafCheck | null {
  if (stem.status === "sucker") return null;
  const observations: LeafObservation[] = stem.observations
    .filter((o) => o.type === "leaves_new" || o.type === "leaves_current")
    .map((o) => ({ type: o.type as LeafObservation["type"], value: Number(o.value), observedAt: new Date(o.observed_at), id: o.id }));
  const removed = (stem.leaves_removed ?? [])
    .filter((r) => Number.isFinite(r.count))
    .map((r) => ({ count: r.count, occurredAt: new Date(r.occurred_at) }));
  return leafCheck(stem.initial_leaf_count, observations, removed);
}
