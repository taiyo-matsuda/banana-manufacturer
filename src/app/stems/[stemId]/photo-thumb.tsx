"use client";

import { useState } from "react";
import type { HistoryPhoto } from "@/lib/stems/records";

// 履歴の写真サムネイル。タップで原寸（アップロード時に縮小済み）を全画面に表示する。
// 画像の URL は非公開バケットの署名付き URL（サーバーで作る）。
export function PhotoThumb({ photo, alt }: { photo: HistoryPhoto; alt: string }) {
  const [open, setOpen] = useState(false);
  if (!photo.url) {
    return (
      <span className="flex h-16 w-16 items-center justify-center rounded bg-zinc-200 text-xs text-zinc-500 dark:bg-zinc-800" data-testid="history-photo-missing">
        画像なし
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block h-16 w-16 shrink-0 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800"
        aria-label={`${alt} を拡大`}
        data-testid="history-photo-open"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- 署名付き URL（1 時間で失効）なので next/image の最適化は通さない */}
        <img src={photo.url} alt={alt} className="h-full w-full object-cover" data-testid="history-photo-thumb" data-photo-id={photo.id} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={alt}
          className="fixed inset-0 z-50 flex flex-col bg-black/90"
          onClick={() => setOpen(false)}
          data-testid="photo-viewer"
        >
          <div className="flex justify-end p-3">
            <button
              type="button"
              className="rounded-lg bg-white/10 px-4 py-2 text-base text-white"
              onClick={() => setOpen(false)}
              data-testid="photo-viewer-close"
            >
              閉じる
            </button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- 同上 */}
          <img src={photo.url} alt={alt} className="min-h-0 flex-1 object-contain" data-testid="photo-viewer-image" />
        </div>
      )}
    </>
  );
}
