// 端末側のデータ（Dexie / IndexedDB）。offline-sync.md 2 章。
//
// 1-9 の範囲は書き込みキューだけ: `outbox`（送信待ち）と `pendingPhotos`（写真の Blob）。
// 読み取りキャッシュ用のストア（fields / mats / stems / observations …）はまだ作らない（ステップ 2 以降）。
// インスタンスはブラウザでのみ生成する（SSR で indexedDB に触らない）。
import Dexie, { type EntityTable } from "dexie";
import type { OutboxItem, PendingPhoto } from "../offline/types";
import type { OutboxStore } from "../offline/worker";

export const DB_NAME = "banana-field-notes";

export class AppDb extends Dexie {
  outbox!: EntityTable<OutboxItem, "id">;
  pendingPhotos!: EntityTable<PendingPhoto, "id">;

  constructor(name = DB_NAME) {
    super(name);
    this.version(1).stores({
      outbox: "id, created_at, stem_id, needs_attention",
      pendingPhotos: "id",
    });
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
