"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { CloudUploadIcon, LoaderCircleIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { outboxItemLabel } from "@/lib/offline/items";
import {
  getSyncState,
  installSyncTriggers,
  requestSync,
  retryAllNeedingAttention,
  retryItem,
  subscribeSync,
  type SyncState,
} from "@/lib/offline/sync-client";
import { useOutbox } from "@/lib/offline/use-live-query";
import {
  type CacheSyncState,
  getCacheSyncState,
  requestCacheImport,
  subscribeCacheSync,
} from "@/lib/offline/cache-client";
import { formatDateTime } from "@/lib/stems/records";

// 未同期件数（1-9）。layout.tsx に 1 つだけ置き、PageHeader の右側（ホームの左）に重ねて表示する（page-header.tsx 参照）。
// - 件数 = outbox の件数（Dexie の liveQuery で購読）。0 でも表示
// - 同期のトリガー（起動時 / online / visibilitychange）をここで 1 回だけ登録する
// - 1 件以上送れたら router.refresh() して、サーバーの最新（同期済みの行、茎の状態）に画面を揃える
// - タップで同期状態のパネル（ヘッダの直下に重なる。背景は覆わないので他の操作を妨げない）:
//   送信中 / 要確認の一覧（last_error 付き、再試行ボタン）/ 手動同期ボタン
// - 読み取りのキャッシュ（2-9）の取り込みも同じトリガーで走る（sync-client.ts → cache-client.ts）。
//   パネルに最終同期の日時、「今すぐ同期」（outbox の送信とキャッシュの差分）と「全件を取り直す」
// - ログイン画面とオフライン画面には出さない
const HIDDEN_PATHS = ["/login", "/offline"];

export function SyncStatus() {
  const pathname = usePathname();
  const router = useRouter();
  const items = useOutbox();
  const [sync, setSync] = useState<SyncState>(() => getSyncState());
  const [cache, setCache] = useState<CacheSyncState>(() => getCacheSyncState());
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLDivElement>(null);

  // チップの幅（「要確認 N」などで変わる）を CSS 変数に書き、PageHeader がタイトルとの間をその分だけ空ける
  useEffect(() => {
    const el = chipRef.current;
    const root = document.documentElement;
    if (!el) return;
    const update = () => root.style.setProperty("--sync-chip-w", `${Math.ceil(el.getBoundingClientRect().width)}px`);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty("--sync-chip-w");
    };
  });

  useEffect(() => {
    const unsubscribe = subscribeSync((state, event) => {
      setSync(state);
      if (event === "finish" && state.lastResult && state.lastResult.sent > 0) router.refresh();
    });
    const unsubscribeCache = subscribeCacheSync(setCache);
    const uninstall = installSyncTriggers();
    return () => {
      unsubscribe();
      unsubscribeCache();
      uninstall();
    };
  }, [router]);

  if (HIDDEN_PATHS.includes(pathname)) return null;

  const count = items?.length ?? null;
  const attention = (items ?? []).filter((i) => i.needs_attention === 1);
  const waiting = (items ?? []).filter((i) => i.needs_attention === 0);

  return (
    <>
      {/* PageHeader（h-14）の右側、ホーム（size-11 + 右余白 8px）の左に重ねる */}
      <div
        ref={chipRef}
        className="fixed top-1.5 right-14 z-50 flex justify-end"
        data-testid="sync-status"
        data-cache-synced-at={cache.meta?.last_synced_at ?? ""}
        data-cache-full-at={cache.meta?.last_full_at ?? ""}
        data-cache-running={cache.running ? "true" : "false"}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "rounded-full px-3 tabular-nums",
            attention.length > 0
              ? "border-destructive text-destructive"
              : count && count > 0
                ? "border-warning-foreground/60 bg-warning text-warning-foreground"
                : "text-muted-foreground",
          )}
          aria-expanded={open}
          aria-label={`未同期 ${count === null ? "" : count} 件`}
          data-testid="sync-indicator"
          data-running={sync.running ? "true" : "false"}
        >
          {sync.running ? (
            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
          ) : (
            <CloudUploadIcon aria-hidden="true" />
          )}
          <span className="font-semibold" data-testid="sync-pending-count">
            {count === null ? "…" : count}
          </span>
          {sync.running && <span className="sr-only">送信中</span>}
          {attention.length > 0 && (
            <span className="text-xs" data-testid="sync-attention-count">
              要確認 {attention.length}
            </span>
          )}
        </Button>
      </div>
      {open && (
        <section
          role="dialog"
          aria-label="同期の状態"
          className="fixed inset-x-0 top-14 z-50 max-h-[70vh] overflow-y-auto border-b bg-popover shadow-lg"
          data-testid="sync-panel"
        >
          <div className="mx-auto flex w-full max-w-md flex-col gap-3 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium" data-testid="sync-summary">
                {sync.running ? "送信中…" : count === 0 ? "すべて同期済み" : `未送信 ${waiting.length} 件・要確認 ${attention.length} 件`}
              </p>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={sync.running}
                  onClick={() => {
                    void requestSync();
                    void requestCacheImport();
                  }}
                  data-testid="sync-now"
                >
                  今すぐ同期
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)} data-testid="sync-close">
                  閉じる
                </Button>
              </div>
            </div>
            {sync.lastRunAt && !sync.running && (
              <p className="text-sm text-muted-foreground">最終送信 {formatDateTime(new Date(sync.lastRunAt))}</p>
            )}
            {/* 読み取りのキャッシュ（2-9）: 最終同期の日時と全件の取り直し（サーバーで消えた行を反映する） */}
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground" data-testid="cache-last-synced">
                {cache.running
                  ? "端末のデータを更新中…"
                  : cache.meta
                    ? `端末のデータ: 最終同期 ${formatDateTime(new Date(cache.meta.last_synced_at))}`
                    : "端末のデータ: まだ同期していません"}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={cache.running}
                onClick={() => void requestCacheImport({ forceFull: true })}
                data-testid="cache-full-resync"
              >
                全件を取り直す
              </Button>
            </div>
            {cache.lastError && !cache.running && (
              <p className="text-sm text-muted-foreground" data-testid="cache-error">
                端末のデータを更新できませんでした（次の同期でやり直します）
              </p>
            )}
            {attention.length > 0 && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="font-semibold text-destructive">要確認（自動では再送しません）</h2>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={sync.running}
                    onClick={() => void retryAllNeedingAttention()}
                    data-testid="sync-retry-all"
                  >
                    すべて再試行
                  </Button>
                </div>
                <ul className="flex flex-col divide-y" data-testid="sync-attention-list">
                  {attention.map((i) => (
                    <li
                      key={i.id}
                      className="flex items-start justify-between gap-3 py-2"
                      data-testid="sync-attention-item"
                      data-kind={i.kind}
                      data-item-id={i.id}
                    >
                      <div className="min-w-0">
                        <p>
                          <span className="font-medium" data-testid="sync-attention-label">
                            {outboxItemLabel(i)}
                          </span>
                          <span className="ml-2 text-xs text-muted-foreground">{formatDateTime(new Date(i.created_at))}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{i.attempts} 回失敗</span>
                        </p>
                        <p className="text-sm break-words text-destructive" data-testid="sync-attention-error">
                          {i.last_error}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        disabled={sync.running}
                        onClick={() => void retryItem(i.id)}
                        data-testid="sync-retry"
                      >
                        再試行
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {waiting.length > 0 && (
              <ul className="flex flex-col divide-y text-sm text-muted-foreground" data-testid="sync-waiting-list">
                {waiting.map((i) => (
                  <li key={i.id} className="py-1.5" data-testid="sync-waiting-item" data-kind={i.kind}>
                    {outboxItemLabel(i)} {formatDateTime(new Date(i.created_at))}
                    {i.last_error && <span className="ml-2">（{i.attempts} 回失敗: {i.last_error}）</span>}
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
