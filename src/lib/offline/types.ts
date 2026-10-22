// オフライン保存と同期（1-9）の型。UI・DB・ブラウザ API に依存しない。
//
// 書き込みの経路は 1 つ（offline-sync.md 1 章）: 画面での記録 → 端末で id を採番 → outbox に積む →
// 同期ワーカーが created_at 順に送る。オンラインでも同じ経路を通る。
// 1-9 の範囲は書き込み（観測・イベント・写真）だけ。読み取りのローカルキャッシュはステップ 2 以降。

export type OutboxKind = "observation" | "event" | "photo";

// observations への 1 行（leaves_new / leaves_current / pseudostem_girth_cm）。upsert ignoreDuplicates で冪等
export type ObservationPayload = {
  id: string;
  stem_id: string;
  type: "leaves_new" | "leaves_current" | "pseudostem_girth_cm" | "height_cm";
  value: number;
  observed_at: string; // ISO
  observed_by: string; // profiles.id（ログインユーザー）
};

// events への直接の追記（枯葉処理）。upsert ignoreDuplicates で冪等
export type EventInsertPayload = {
  method: "insert";
  id: string;
  type: "leaves_removed";
  target_type: "stem";
  target_id: string;
  occurred_at: string;
  recorded_by: string;
  payload: Record<string, unknown>;
};

// RPC record_stem_event（0009）。p_id で冪等（同じ id の events 行があれば何もしない）
export type StemEventRpcPayload = {
  method: "record_stem_event";
  id: string;
  stem_id: string;
  type: "bud_emerged" | "hands_counted" | "bagged" | "debudded" | "harvested" | "damage";
  occurred_at: string;
  payload: Record<string, unknown>;
  note: string | null;
};

export type EventPayload = EventInsertPayload | StemEventRpcPayload;

// 写真。Blob は pendingPhotos（同じ id）に別に持つ。uploaded は Storage への保存が済んだか（済んでいれば再送は DB だけ）
export type PhotoPayload = {
  id: string;
  target_type: "stem";
  target_id: string;
  storage_path: string;
  content_type: string;
  taken_at: string;
  taken_by: string;
  lat: number | null;
  lng: number | null;
  kind: string;
  uploaded: boolean;
};

export type OutboxItemBase = {
  id: string; // 送る行の id と同じ（observations.id / events.id / photos.id）
  stem_id: string; // 画面への重ね合わせ用（この茎の未送信分を引く）
  created_at: string; // ISO。この順に送る
  attempts: number; // 失敗した回数
  last_error: string | null;
  next_attempt_at: number | null; // 指数バックオフの次回時刻（epoch ms）。null は即時
  needs_attention: 0 | 1; // 1 = 要確認（自動では再送しない。手動で再試行）。Dexie の index 用に数値
};

export type OutboxItem =
  | (OutboxItemBase & { kind: "observation"; payload: ObservationPayload })
  | (OutboxItemBase & { kind: "event"; payload: EventPayload })
  | (OutboxItemBase & { kind: "photo"; payload: PhotoPayload });

export type PendingPhoto = {
  id: string; // photos.id
  blob: Blob;
  content_type: string;
};

// 送信に失敗したときの正規化したエラー（supabase-js の PostgrestError / StorageError / fetch の TypeError をこの形にする）
export type SendError = {
  message: string;
  code?: string | null;
  status?: number | null;
  name?: string | null;
};
