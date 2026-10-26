"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { HistoryPhoto } from "@/lib/stems/records";

// 履歴の写真サムネイル。タップで原寸（アップロード時に縮小済み）を全画面に表示する。
// 画像の URL は非公開バケットの署名付き URL（サーバーで作る）。
export function PhotoThumb({ photo, alt }: { photo: HistoryPhoto; alt: string }) {
  const [open, setOpen] = useState(false);
  // オフラインの殻（2-9）: 画像本体はキャッシュしないので、サムネイルの代わりに理由を出す
  if (!photo.url && photo.offline) {
    return (
      <span className="shrink-0 text-sm text-muted-foreground" data-testid="history-photo-offline">
        写真（オフラインでは表示できません）
      </span>
    );
  }
  if (!photo.url) {
    return (
      <span
        className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground"
        data-testid="history-photo-missing"
      >
        画像なし
      </span>
    );
  }
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setOpen(true)}
        className="size-16 shrink-0 overflow-hidden rounded-lg bg-muted p-0"
        aria-label={`${alt} を拡大`}
        data-testid="history-photo-open"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- 署名付き URL（1 時間で失効）なので next/image の最適化は通さない */}
        <img src={photo.url} alt={alt} className="size-full object-cover" data-testid="history-photo-thumb" data-photo-id={photo.id} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          className="top-0 left-0 flex h-dvh max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-black p-0 text-white sm:max-w-none"
          data-testid="photo-viewer"
        >
          <DialogTitle className="sr-only">{alt}</DialogTitle>
          <div className="flex justify-end p-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setOpen(false)}
              className="bg-white/15 text-white hover:bg-white/25"
              data-testid="photo-viewer-close"
            >
              閉じる
            </Button>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element -- 同上 */}
          <img src={photo.url} alt={alt} className="min-h-0 flex-1 object-contain" data-testid="photo-viewer-image" onClick={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
