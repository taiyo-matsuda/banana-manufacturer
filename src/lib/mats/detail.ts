// 株の詳細（画面 3）に渡すデータの形。サーバー（RSC、src/app/mats/[matId]/page.tsx）とオフラインの殻（2-9、端末のキャッシュ）で共通。
// 表示の部品（src/app/mats/[matId]/mat-detail-view.tsx）はこの形だけを受け取る。
import type { MatStemRow } from "../offline/overlay";
import type { EventRow } from "../stems/records";

export type MatDetailData = {
  mat: { id: string; code: string; planted_at: string; origin_type: string; status: string };
  field: { id: string; name: string; code: string } | null;
  cultivarName: string | null;
  // 株分け（2-2）で作った株の由来（元の茎の世代と、その茎の株）
  origin: { matId: string; matCode: string; generation: number } | null;
  stems: MatStemRow[]; // 世代順。観測は現在の値（superseded_by が null）だけ
  stemsError: string | null;
  removedEvent: { occurred_at: string; payload: unknown } | null; // 撤去の記録（撤去済みのときだけ使う）
  history: EventRow[]; // 株単位のイベント（新しい順）
  historyError: string | null;
};

// 株の記録に出す件数（新しい順）
export const MAT_HISTORY_LIMIT = 50;
