"use client";

// 同期の起動（ブラウザ側）。offline-sync.md 4 章。
//
// - トリガー: 起動時、online イベント、visibilitychange、記録直後、手動ボタン（SyncStatus が呼ぶ）
// - 同時に 2 つのワーカーが走らないよう、実行中なら「終わったらもう一度」の印だけ立てる
// - バックオフ中の項目があれば、その時刻にタイマーで再実行する
// - 1 件以上送れたら listeners に知らせる（画面は router.refresh() でサーバーの最新に揃える）
import { getDb, hasIndexedDb, outboxStore } from "../db";
import { refreshCacheMeta, requestCacheImport, requestCacheImportWhenIdle } from "./cache-client";
import { forRetry } from "./retry";
import { createSender } from "./sender";
import { runOutbox, type RunResult, type Sender } from "./worker";

export type SyncState = {
  running: boolean;
  lastResult: RunResult | null;
  lastRunAt: number | null;
};

type Listener = (state: SyncState, event: "start" | "finish") => void;

let running: Promise<RunResult> | null = null;
let runAgain = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let sender: Sender | null = null;
const listeners = new Set<Listener>();
let state: SyncState = { running: false, lastResult: null, lastRunAt: null };

function emit(event: "start" | "finish") {
  for (const l of listeners) l(state, event);
}

export function subscribeSync(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSyncState(): SyncState {
  return state;
}

export const isOnline = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false);

// outbox を送る。実行中なら終了後にもう一度走らせる。戻り値は今回（または進行中）の実行
export function requestSync(): Promise<RunResult> {
  if (!hasIndexedDb()) return Promise.resolve({ sent: 0, failed: 0, skipped: 0, nextAttemptAt: null });
  if (running) {
    runAgain = true;
    return running;
  }
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  running = (async () => {
    state = { ...state, running: true };
    emit("start");
    let result: RunResult = { sent: 0, failed: 0, skipped: 0, nextAttemptAt: null };
    try {
      const db = getDb();
      sender ??= createSender(db);
      result = await runOutbox(outboxStore(db), sender, { online: isOnline });
    } catch (err) {
      console.error("sync failed", err);
    } finally {
      running = null;
      state = { running: false, lastResult: result, lastRunAt: Date.now() };
      emit("finish");
      // 送った行を読み取りのキャッシュにも入れる（2-9）
      if (result.sent > 0) void requestCacheImport();
      if (runAgain) {
        runAgain = false;
        void requestSync();
      } else if (result.nextAttemptAt !== null) {
        timer = setTimeout(() => {
          timer = null;
          void requestSync();
        }, Math.max(0, result.nextAttemptAt - Date.now()));
      }
    }
    return result;
  })();
  return running;
}

// 要確認の項目を手動で再試行する（要確認を外してすぐ送る）
export async function retryItem(id: string): Promise<RunResult> {
  const db = getDb();
  const item = await db.outbox.get(id);
  if (item) await db.outbox.put(forRetry(item));
  return requestSync();
}

export async function retryAllNeedingAttention(): Promise<RunResult> {
  const db = getDb();
  const items = await db.outbox.where("needs_attention").equals(1).toArray();
  await db.outbox.bulkPut(items.map(forRetry));
  return requestSync();
}

// 起動時・online・visibilitychange で同期する。SyncStatus（ヘッダ）が 1 回だけ登録する。
// 読み取りのキャッシュの取り込み（2-9、cache-client.ts）も同じトリガーで走らせる（起動時はブラウザが空いてから）
export function installSyncTriggers(): () => void {
  if (typeof window === "undefined") return () => {};
  const onOnline = () => {
    void requestSync();
    void requestCacheImport();
  };
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    void requestSync();
    void requestCacheImport();
  };
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  void requestSync();
  void refreshCacheMeta().catch(() => null);
  const cancelIdle = requestCacheImportWhenIdle();
  return () => {
    cancelIdle();
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
