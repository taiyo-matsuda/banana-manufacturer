"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { outboxItemLabel } from "@/lib/offline/items";
import { getSyncState, installSyncTriggers, requestSync, retryAllNeedingAttention, retryItem, subscribeSync, type SyncState } from "@/lib/offline/sync-client";
import { useOutbox } from "@/lib/offline/use-live-query";
import { formatDateTime } from "@/lib/stems/records";

// 全画面のヘッダ（layout.tsx）: 未同期件数（0 でも表示）。タップで同期の状態を見る。
// - 件数 = outbox の件数（Dexie の liveQuery で購読）
// - 同期のトリガー（起動時 / online / visibilitychange）をここで 1 回だけ登録する
// - 1 件以上送れたら router.refresh() して、サーバーの最新（同期済みの行、茎の状態）に画面を揃える
// - 同期状態: 送信中 / 要確認の一覧（last_error 付き、再試行ボタン）/ 手動同期ボタン
export function SyncStatus() {
  const router = useRouter();
  const items = useOutbox();
  const [sync, setSync] = useState<SyncState>(() => getSyncState());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeSync((state, event) => {
      setSync(state);
      if (event === "finish" && state.lastResult && state.lastResult.sent > 0) router.refresh();
    });
    const uninstall = installSyncTriggers();
    return () => {
      unsubscribe();
      uninstall();
    };
  }, [router]);

  const count = items?.length ?? null;
  const attention = (items ?? []).filter((i) => i.needs_attention === 1);
  const waiting = (items ?? []).filter((i) => i.needs_attention === 0);

  return (
    <>
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-zinc-200 bg-white/95 px-4 py-2 text-sm backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/95">
        <span className="text-xs text-zinc-500">バナナ生育記録</span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={`flex h-9 items-center gap-2 rounded-full border px-3 ${
            attention.length > 0
              ? "border-red-400 text-red-700 dark:text-red-300"
              : count && count > 0
                ? "border-amber-400 text-amber-800 dark:text-amber-200"
                : "border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
          }`}
          aria-expanded={open}
          data-testid="sync-indicator"
          data-running={sync.running ? "true" : "false"}
        >
          <span>未同期</span>
          <span className="font-semibold tabular-nums" data-testid="sync-pending-count">
            {count === null ? "…" : count}
          </span>
          {sync.running && <span className="text-xs">送信中</span>}
          {attention.length > 0 && (
            <span className="text-xs" data-testid="sync-attention-count">
              要確認 {attention.length}
            </span>
          )}
        </button>
      </header>
      {open && (
        <section
          role="dialog"
          aria-label="同期の状態"
          className="border-b border-zinc-200 bg-amber-50 px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900"
          data-testid="sync-panel"
        >
          <div className="mx-auto flex w-full max-w-md flex-col gap-3">
            <div className="flex items-center justify-between">
              <p data-testid="sync-summary">
                {sync.running ? "送信中…" : count === 0 ? "すべて同期済み" : `未送信 ${waiting.length} 件・要確認 ${attention.length} 件`}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={sync.running}
                  onClick={() => void requestSync()}
                  className="h-9 rounded-lg border border-zinc-300 px-3 dark:border-zinc-700"
                  data-testid="sync-now"
                >
                  今すぐ同期
                </button>
                <button type="button" onClick={() => setOpen(false)} className="h-9 rounded-lg border border-zinc-300 px-3 dark:border-zinc-700" data-testid="sync-close">
                  閉じる
                </button>
              </div>
            </div>
            {sync.lastRunAt && !sync.running && (
              <p className="text-xs text-zinc-500">最終同期 {formatDateTime(new Date(sync.lastRunAt))}</p>
            )}
            {attention.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h2 className="font-semibold text-red-700 dark:text-red-300">要確認（自動では再送しません）</h2>
                  <button
                    type="button"
                    disabled={sync.running}
                    onClick={() => void retryAllNeedingAttention()}
                    className="h-9 rounded-lg border border-red-400 px-3 text-red-700 dark:text-red-300"
                    data-testid="sync-retry-all"
                  >
                    すべて再試行
                  </button>
                </div>
                <ul className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800" data-testid="sync-attention-list">
                  {attention.map((i) => (
                    <li key={i.id} className="flex items-start justify-between gap-3 py-2" data-testid="sync-attention-item" data-kind={i.kind} data-item-id={i.id}>
                      <div className="min-w-0">
                        <p>
                          <span className="font-medium" data-testid="sync-attention-label">
                            {outboxItemLabel(i)}
                          </span>
                          <span className="ml-2 text-xs text-zinc-500">{formatDateTime(new Date(i.created_at))}</span>
                          <span className="ml-2 text-xs text-zinc-500">{i.attempts} 回失敗</span>
                        </p>
                        <p className="break-words text-xs text-red-700 dark:text-red-300" data-testid="sync-attention-error">
                          {i.last_error}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={sync.running}
                        onClick={() => void retryItem(i.id)}
                        className="h-9 shrink-0 rounded-lg border border-zinc-300 px-3 dark:border-zinc-700"
                        data-testid="sync-retry"
                      >
                        再試行
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {waiting.length > 0 && (
              <ul className="flex flex-col divide-y divide-zinc-200 text-xs text-zinc-600 dark:divide-zinc-800 dark:text-zinc-300" data-testid="sync-waiting-list">
                {waiting.map((i) => (
                  <li key={i.id} className="py-1" data-testid="sync-waiting-item" data-kind={i.kind}>
                    {outboxItemLabel(i)} {formatDateTime(new Date(i.created_at))}
                    {i.last_error && <span className="ml-2 text-zinc-500">（{i.attempts} 回失敗: {i.last_error}）</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </>
  );
}
