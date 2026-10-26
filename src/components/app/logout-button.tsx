"use client";

import { useRef, useState } from "react";
import { LogOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { logout } from "@/app/login/actions";
import { clearLocalDataForLogout, pendingOutboxCount } from "@/lib/offline/logout";
import { clearDeviceStore } from "./device-store";

// ログアウト（設定 /fields）。送信の前に端末に残したものを消す（次に別のユーザーでログインしたとき、
// 前のユーザーの株・圃場・記録を見せたり送ったりしないように）:
// - 「最近開いた株」「直近の圃場」（UX-1）
// - 読み取りのキャッシュ・カーソル・最終同期の日時、Service Worker のナビゲーションのキャッシュ（2-9、offline-sync.md 5.7）
// - 未送信の記録（outbox）が残っていれば「未同期の記録が N 件あります。ログアウトすると失われます」と確認し、
//   了承したときだけ outbox と写真の Blob も消してログアウトする。やめればログアウトしない
export function LogoutButton() {
  const formRef = useRef<HTMLFormElement>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (discardOutbox: boolean) => {
    setBusy(true);
    try {
      clearDeviceStore();
      await clearLocalDataForLogout({ discardOutbox });
    } catch (err) {
      console.error("端末のデータを消せませんでした", err);
    }
    formRef.current?.requestSubmit();
  };

  const onLogout = async () => {
    if (busy) return;
    const count = await pendingOutboxCount().catch(() => 0);
    if (count > 0) {
      setPendingCount(count);
      return;
    }
    await submit(false);
  };

  return (
    <form ref={formRef} action={logout}>
      <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => void onLogout()} data-testid="logout">
        <LogOutIcon aria-hidden="true" />
        {busy ? "ログアウト中…" : "ログアウト"}
      </Button>
      <Dialog open={pendingCount !== null} onOpenChange={(open) => !open && setPendingCount(null)}>
        <DialogContent data-testid="logout-confirm">
          <DialogHeader>
            <DialogTitle>未同期の記録があります</DialogTitle>
            <DialogDescription data-testid="logout-confirm-message">
              未同期の記録が {pendingCount} 件あります。ログアウトすると失われます
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row gap-3">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="flex-1"
              disabled={busy}
              onClick={() => setPendingCount(null)}
              data-testid="logout-cancel"
            >
              やめる
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="lg"
              className="flex-1"
              disabled={busy}
              onClick={() => void submit(true)}
              data-testid="logout-discard"
            >
              失ってログアウト
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
