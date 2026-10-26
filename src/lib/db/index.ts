// 端末側のデータ（Dexie / IndexedDB）。offline-sync.md 2 章・5.3。
//
// - バージョン 1（1-9）: 書き込みキュー `outbox`（送信待ち）と `pendingPhotos`（写真の Blob）
// - バージョン 2（2-9）: 読み取りのキャッシュ（fields / mats / stems / observations / events / photos）と
//   差分のカーソル `syncCursors`、`syncMeta`（最終同期の日時・最後に全件を取り直した日時・キャッシュの持ち主）
// キャッシュはサーバーの行の写し（RLS で見えた自組織の行だけ）。書き込みの代わりにしない（記録は outbox → サーバー）。
// インスタンスはブラウザでのみ生成する（SSR で indexedDB に触らない）。
import Dexie, { type EntityTable } from "dexie";
import type { CacheStore } from "../cache/importer";
import {
  CACHE_TABLES,
  type CacheSnapshot,
  type CacheTable,
  type CachedEvent,
  type CachedField,
  type CachedMat,
  type CachedObservation,
  type CachedPhoto,
  type CachedRow,
  type CachedStem,
  type SyncCursor,
  type SyncMeta,
} from "../cache/types";
import type { OutboxItem, PendingPhoto } from "../offline/types";
import type { OutboxStore } from "../offline/worker";

export const DB_NAME = "banana-field-notes";

export class AppDb extends Dexie {
  outbox!: EntityTable<OutboxItem, "id">;
  pendingPhotos!: EntityTable<PendingPhoto, "id">;
  fields!: EntityTable<CachedField, "id">;
  mats!: EntityTable<CachedMat, "id">;
  stems!: EntityTable<CachedStem, "id">;
  observations!: EntityTable<CachedObservation, "id">;
  events!: EntityTable<CachedEvent, "id">;
  photos!: EntityTable<CachedPhoto, "id">;
  syncCursors!: EntityTable<SyncCursor, "table">;
  syncMeta!: EntityTable<SyncMeta, "key">;

  constructor(name = DB_NAME) {
    super(name);
    this.version(1).stores({
      outbox: "id, created_at, stem_id, needs_attention",
      pendingPhotos: "id",
    });
    // 2-9: 読み取りのキャッシュ。索引は画面の組み立てに使うもの
    this.version(2).stores({
      outbox: "id, created_at, stem_id, needs_attention",
      pendingPhotos: "id",
      fields: "id",
      mats: "id, field_id",
      stems: "id, mat_id",
      observations: "id, stem_id",
      events: "id, [target_type+target_id]",
      photos: "id, [target_type+target_id]",
      syncCursors: "table",
      syncMeta: "key",
    });
  }

  cacheTable(table: CacheTable): EntityTable<CachedRow, "id"> {
    return this.table(table) as unknown as EntityTable<CachedRow, "id">;
  }
}

let instance: AppDb | null = null;

export function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

// ブラウザでだけ使う。サーバー（SSR）で呼ぶと例外
export function getDb(): AppDb {
  if (!hasIndexedDb()) throw new Error("IndexedDB はブラウザでだけ使えます");
  if (!instance) instance = new AppDb();
  return instance;
}

// 同期ワーカー（src/lib/offline/worker.ts）に渡す outbox の読み書き
export function outboxStore(db: AppDb = getDb()): OutboxStore {
  return {
    list: () => db.outbox.orderBy("created_at").toArray(),
    remove: (id) => db.outbox.delete(id),
    put: async (item) => {
      await db.outbox.put(item);
    },
  };
}

const cacheStores = (db: AppDb) => [...CACHE_TABLES.map((t) => db.cacheTable(t)), db.syncCursors, db.syncMeta];

// 差分の取り込み（src/lib/cache/importer.ts）に渡すキャッシュの読み書き
export function cacheStore(db: AppDb = getDb()): CacheStore {
  return {
    getMeta: async () => (await db.syncMeta.get("meta")) ?? null,
    getCursor: async (table) => (await db.syncCursors.get(table)) ?? null,
    applyPage: (table, rows, cursor) =>
      db.transaction("rw", [db.cacheTable(table), db.syncCursors], async () => {
        await db.cacheTable(table).bulkPut(rows);
        if (cursor) await db.syncCursors.put(cursor);
      }),
    replaceAll: (rows, cursors, meta) =>
      db.transaction("rw", cacheStores(db), async () => {
        for (const t of CACHE_TABLES) {
          await db.cacheTable(t).clear();
          await db.cacheTable(t).bulkPut(rows[t]);
        }
        await db.syncCursors.clear();
        await db.syncCursors.bulkPut(cursors);
        await db.syncMeta.put(meta);
      }),
    setMeta: async (meta) => {
      await db.syncMeta.put(meta);
    },
    clearCache: () => clearCache(db),
  };
}

// キャッシュ（6 表・カーソル・meta）を消す。outbox と pendingPhotos は残す（ログアウト時の消去は clearOutbox と合わせて呼ぶ）
export async function clearCache(db: AppDb = getDb()): Promise<void> {
  await db.transaction("rw", cacheStores(db), async () => {
    for (const s of cacheStores(db)) await s.clear();
  });
}

// 未送信の記録（outbox と pendingPhotos）を消す。ログアウトで「失われます」を了承したときだけ（5.7）
export async function clearOutbox(db: AppDb = getDb()): Promise<void> {
  await db.transaction("rw", [db.outbox, db.pendingPhotos], async () => {
    await db.outbox.clear();
    await db.pendingPhotos.clear();
  });
}

export async function getSyncMeta(db: AppDb = getDb()): Promise<SyncMeta | null> {
  return (await db.syncMeta.get("meta")) ?? null;
}

const emptySnapshot = (): CacheSnapshot => ({ fields: [], mats: [], stems: [], observations: [], events: [], photos: [] });

// オフラインの殻（2-9）が画面ごとに読むキャッシュの一部。索引で必要な行だけを読む（src/lib/cache/views.ts に渡す）
export async function readHomeSnapshot(db: AppDb = getDb()): Promise<CacheSnapshot> {
  const [fields, mats, stems, observations] = await Promise.all([
    db.fields.toArray(),
    db.mats.toArray(),
    db.stems.toArray(),
    db.observations.toArray(),
  ]);
  return { ...emptySnapshot(), fields, mats, stems, observations };
}

export async function readFieldSnapshot(fieldId: string, db: AppDb = getDb()): Promise<CacheSnapshot> {
  const [field, mats, events] = await Promise.all([
    db.fields.get(fieldId),
    db.mats.where("field_id").equals(fieldId).toArray(),
    db.events.where("[target_type+target_id]").equals(["field", fieldId]).toArray(),
  ]);
  const stems = mats.length === 0 ? [] : await db.stems.where("mat_id").anyOf(mats.map((m) => m.id)).toArray();
  return { ...emptySnapshot(), fields: field ? [field] : [], mats, stems, events };
}

export async function readMatSnapshot(matId: string, db: AppDb = getDb()): Promise<CacheSnapshot> {
  const mat = await db.mats.get(matId);
  if (!mat) return emptySnapshot();
  const [field, stems, events] = await Promise.all([
    db.fields.get(mat.field_id),
    db.stems.where("mat_id").equals(matId).toArray(),
    db.events.where("[target_type+target_id]").equals(["mat", matId]).toArray(),
  ]);
  const observations = stems.length === 0 ? [] : await db.observations.where("stem_id").anyOf(stems.map((s) => s.id)).toArray();
  // 株分けの由来（元の茎とその株）
  const mats: CachedMat[] = [mat];
  if (mat.origin_stem_id) {
    const originStem = await db.stems.get(mat.origin_stem_id);
    if (originStem) {
      stems.push(originStem);
      const originMat = await db.mats.get(originStem.mat_id);
      if (originMat) mats.push(originMat);
    }
  }
  return { ...emptySnapshot(), fields: field ? [field] : [], mats, stems, observations, events };
}

export async function readStemSnapshot(stemId: string, db: AppDb = getDb()): Promise<CacheSnapshot> {
  const stem = await db.stems.get(stemId);
  if (!stem) return emptySnapshot();
  const [mat, observations, events, photos] = await Promise.all([
    db.mats.get(stem.mat_id),
    db.observations.where("stem_id").equals(stemId).toArray(),
    db.events.where("[target_type+target_id]").equals(["stem", stemId]).toArray(),
    db.photos.where("[target_type+target_id]").equals(["stem", stemId]).toArray(),
  ]);
  return { ...emptySnapshot(), mats: mat ? [mat] : [], stems: [stem], observations, events, photos };
}
