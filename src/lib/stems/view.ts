// 茎の記録入力（画面 4）と履歴（画面 8）に渡すデータ（StemView）の組み立て。純粋関数。
// サーバー（src/app/stems/[stemId]/load.ts、RSC）とオフラインの殻（2-9、端末のキャッシュ）で共通に使う。
// 違うのはデータの取り方だけ（観測・イベント・写真の行をどこから持ってくるか）。
import { type BudLeafSnapshot, budLeafSnapshot } from "../corrections";
import { cumulativeLeaves, cumulativeLeavesByCheck, leafCheckWarning } from "../leaves";
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
  byCheck: number | null;
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
  const byCheck = cumulativeLeavesByCheck(leafObs, toLeavesRemoved(events));
  return {
    ...input,
    cumulative,
    byCheck,
    checkWarning: leafCheckWarning(cumulative, byCheck),
    canRecord: canRecordLeaves(input.status),
    latestObservedOn: latestDateJst(observations.filter((o) => o.superseded_by === null).map((o) => o.observed_at)),
    budSnapshot: budLeafSnapshot(initialLeafCount, observations, events),
    history: buildHistory(observations, events, photos),
  };
}
