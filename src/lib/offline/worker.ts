// 同期ワーカーの本体（純粋ロジック）。outbox の読み書きと送信は注入する（Dexie / supabase-js はブラウザ側で渡す）。
//
// - created_at 順に 1 件ずつ送り、成功したら outbox から消す
// - 失敗は retry.ts の規則で attempts / last_error / next_attempt_at / needs_attention を更新する
// - 要確認（needs_attention）とバックオフ中の項目は飛ばして次へ進む（手動再試行は forRetry で要確認を外してから走らせる）
// - 圏外（online() が false）なら何も送らない（attempts を無駄に増やさない。online イベントで再開する）
import { afterFailure, isDue, toSendError } from "./retry";
import type { OutboxItem } from "./types";

export type OutboxStore = {
  list(): Promise<OutboxItem[]>; // created_at 順
  remove(id: string): Promise<void>;
  put(item: OutboxItem): Promise<void>;
};

// 項目を送る。失敗は throw（SendError に正規化できるもの）。写真のように途中経過があるものは progress で payload を保存する
export type Sender = (item: OutboxItem, progress: (item: OutboxItem) => Promise<void>) => Promise<void>;

export type RunOptions = {
  now?: () => number;
  online?: () => boolean;
};

export type RunResult = {
  sent: number;
  failed: number;
  skipped: number;
  nextAttemptAt: number | null; // バックオフ中の項目があればその最も早い時刻（タイマーの設定用）
};

export async function runOutbox(store: OutboxStore, sender: Sender, options: RunOptions = {}): Promise<RunResult> {
  const now = options.now ?? (() => Date.now());
  const online = options.online ?? (() => true);
  const result: RunResult = { sent: 0, failed: 0, skipped: 0, nextAttemptAt: null };
  if (!online()) {
    result.skipped = (await store.list()).length;
    return result;
  }

  const items = [...(await store.list())].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const item of items) {
    if (!isDue(item, now())) {
      result.skipped += 1;
      if (item.needs_attention === 0 && item.next_attempt_at !== null) {
        result.nextAttemptAt = result.nextAttemptAt === null ? item.next_attempt_at : Math.min(result.nextAttemptAt, item.next_attempt_at);
      }
      continue;
    }
    let current = item;
    try {
      await sender(current, async (progressed) => {
        current = progressed;
        await store.put(progressed);
      });
      await store.remove(current.id);
      result.sent += 1;
    } catch (err) {
      const failed = afterFailure(current, toSendError(err), online(), now());
      await store.put(failed);
      result.failed += 1;
      if (failed.needs_attention === 0 && failed.next_attempt_at !== null) {
        result.nextAttemptAt = result.nextAttemptAt === null ? failed.next_attempt_at : Math.min(result.nextAttemptAt, failed.next_attempt_at);
      }
      // 圏外になったら残りは次の online で送る
      if (!online()) break;
    }
  }
  return result;
}
