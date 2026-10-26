// 読み取りのローカルキャッシュ（2-9、offline-sync.md 5 章）の型。UI・DB・ブラウザ API に依存しない。
//
// キャッシュはサーバーの行の「写し」で、正本ではない。書き込みは従来どおり outbox → サーバー（3・4 章）。
// 行は RLS で見えた列そのまま（select *）。ここでは画面の組み立てに使う列だけを型にする（他の列も入っている）。

export const CACHE_TABLES = ["fields", "mats", "stems", "observations", "events", "photos"] as const;
export type CacheTable = (typeof CACHE_TABLES)[number];

// 全行に共通（差分のカーソルに使う）
export type CachedRowBase = {
  id: string;
  organization_id: string;
  updated_at: string; // ISO（timestamptz）
  created_at: string;
};

export type CachedField = CachedRowBase & {
  name: string;
  code: string;
  center_lat: number;
  center_lng: number;
  notes: string | null;
};

export type CachedMat = CachedRowBase & {
  field_id: string;
  code: string;
  cultivar_id: string;
  lat: number;
  lng: number;
  planted_at: string; // YYYY-MM-DD
  origin_type: string;
  origin_stem_id: string | null;
  status: string;
};

export type CachedStem = CachedRowBase & {
  mat_id: string;
  generation: number;
  parent_stem_id: string | null;
  status: string;
  started_at: string; // YYYY-MM-DD
  initial_leaf_count: number;
  bud_emerged_at: string | null;
};

export type CachedObservation = CachedRowBase & {
  stem_id: string;
  type: string;
  value: number | string; // numeric は文字列で返ることがある（使うときに Number）
  observed_at: string;
  observed_by: string | null;
  note: string | null;
  superseded_by: string | null;
};

export type CachedEvent = CachedRowBase & {
  type: string;
  target_type: string;
  target_id: string;
  occurred_at: string;
  recorded_by: string | null;
  payload: Record<string, unknown> | null;
  note: string | null;
  superseded_by: string | null;
};

// 写真はメタデータだけ（画像本体はキャッシュしない）
export type CachedPhoto = CachedRowBase & {
  storage_path: string;
  taken_at: string;
  taken_by: string | null;
  target_type: string;
  target_id: string;
  kind: string;
};

export type CachedRowByTable = {
  fields: CachedField;
  mats: CachedMat;
  stems: CachedStem;
  observations: CachedObservation;
  events: CachedEvent;
  photos: CachedPhoto;
};

export type CachedRow = CachedRowByTable[CacheTable];

// テーブルごとの差分のカーソル（前回取り込んだ最後の行の (updated_at, id)）
export type SyncCursor = { table: CacheTable; updated_at: string; id: string };

// キャッシュの持ち主（ログイン中のユーザーと組織）
export type CacheOwner = { organization_id: string; user_id: string };

export type SyncMeta = CacheOwner & {
  key: "meta";
  last_synced_at: string; // ISO。最後に取り込みが終わった日時
  last_full_at: string; // ISO。最後に全件を取り直した日時
  // 画面の表示用（6 表に入らないもの）。取り込みのたびに取り直す
  organization_name: string | null;
  display_name: string | null;
  cultivars: { id: string; name: string }[];
};

// キャッシュ全体（画面の組み立ての入力）
export type CacheSnapshot = {
  fields: CachedField[];
  mats: CachedMat[];
  stems: CachedStem[];
  observations: CachedObservation[];
  events: CachedEvent[];
  photos: CachedPhoto[];
};
