// 圃場の詳細に渡すデータの形。サーバー（RSC、src/app/fields/[fieldId]/page.tsx）とオフラインの殻（2-9）で共通。
import type { EventRow } from "../stems/records";

export type FieldDetailData = {
  field: { id: string; name: string; code: string; center_lat: number; center_lng: number; notes: string | null };
  history: EventRow[]; // 圃場単位のイベント（新しい順）
  historyError: string | null;
};

// 圃場の記録に出す件数（新しい順）
export const FIELD_HISTORY_LIMIT = 50;
