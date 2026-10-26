"use client";

// ログアウト時の端末のデータの消去（2-9、offline-sync.md 5.7）。
// - 読み取りのキャッシュ（6 表）・カーソル・meta を消す
// - 未送信の記録（outbox・pendingPhotos）は、利用者が「失われます」を了承したときだけ消す（別のユーザーの記録として送らないように）
// - Service Worker のナビゲーションのキャッシュ（shell-* の HTML）を消す。/offline と /offline-shell は残す
//   （別のユーザーが圏外で前のユーザーの画面を見ないように。殻と /offline はデータを持たない）
import { clearCache, clearOutbox, getDb, hasIndexedDb } from "../db";
import { resetCacheSyncState, suspendCacheImport } from "./cache-client";

const KEEP_PATHS = new Set(["/offline", "/offline-shell"]);

export async function pendingOutboxCount(): Promise<number> {
  if (!hasIndexedDb()) return 0;
  return getDb().outbox.count();
}

export async function clearNavigationCache(): Promise<void> {
  if (typeof caches === "undefined") return;
  const names = (await caches.keys()).filter((n) => n.startsWith("shell-"));
  for (const name of names) {
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      if (!KEEP_PATHS.has(new URL(req.url).pathname)) await cache.delete(req);
    }
  }
}

export async function clearLocalDataForLogout({ discardOutbox }: { discardOutbox: boolean }): Promise<void> {
  // 実行中の取り込みが終わるのを待ち、ログアウトが終わるまで新しい取り込みを始めない（消した直後に書き戻さない）
  await suspendCacheImport();
  if (hasIndexedDb()) {
    const db = getDb();
    await clearCache(db);
    if (discardOutbox) await clearOutbox(db);
  }
  resetCacheSyncState();
  await clearNavigationCache().catch((err) => console.warn("ナビゲーションのキャッシュを消せませんでした", err));
}
