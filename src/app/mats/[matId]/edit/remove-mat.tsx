"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FormField } from "@/components/app/form-field";
import { forgetRecentMat } from "@/components/app/remember-mat";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { MAX_REMOVE_REASON_LENGTH, parseRemoveReason, type RemoveCheck } from "@/lib/mats/remove";
import { useOnline } from "@/lib/offline/use-online";
import { removeMat } from "./actions";

// 株の撤去（2-3、要確認 11）。株の編集画面の下に、危険な操作として控えめに置く。
// 確認ダイアログで理由（任意のメモ）を入れて確定 → Server Action removeMat（RPC remove_mat、0012）。
// 栽培中の茎・未処理の吸芽があればボタンを無効にして理由を出す（check。正本は DB の RPC で、画面を開いた後に
// 状態が変わった場合は RPC の理由をダイアログに出す）。オンライン前提（株の属性の変更は 1-9 の設計どおり）。
// 撤去したら端末の「最近開いた株」から外し、株の詳細（撤去済み）へ戻る。
export function RemoveMat({ matId, code, check }: { matId: string; code: string; check: RemoveCheck }) {
  const router = useRouter();
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // 同じ確定の二重送信は RPC が p_event_id で 1 回にする。ダイアログを開くたびに採番し直す
  const eventId = useRef<string | null>(null);

  const openDialog = () => {
    eventId.current = crypto.randomUUID();
    setReason("");
    setError(null);
    setOpen(true);
  };

  const submit = async () => {
    if (pending) return;
    const parsed = parseRemoveReason(reason);
    if (!parsed.ok) return setError(parsed.error);
    setPending(true);
    try {
      const result = await removeMat({ eventId: eventId.current ?? crypto.randomUUID(), matId, reason });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      forgetRecentMat(matId);
      setOpen(false);
      router.replace(`/mats/${matId}`);
    } catch (err) {
      console.error("remove mat failed", err);
      setError("撤去を保存できませんでした。通信を確かめて再度お試しください");
    } finally {
      setPending(false);
    }
  };

  const blockedReason = !check.ok ? check.reason : !online ? "撤去は電波のあるところで行ってください" : null;

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-4" data-testid="mat-remove-section">
      <p className="text-sm text-muted-foreground">
        株を抜いた・枯れたときは撤去します。撤去した株は地図に出なくなり、記録はそのまま残ります（元に戻せません）
      </p>
      <Button
        type="button"
        variant="destructive"
        onClick={openDialog}
        disabled={blockedReason !== null}
        data-testid="mat-remove-open"
      >
        株を撤去する
      </Button>
      {blockedReason && (
        <p className="text-sm text-muted-foreground" data-testid="mat-remove-blocked">
          {blockedReason}
        </p>
      )}

      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent showCloseButton={false} data-testid="mat-remove-dialog">
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>株 {code} を撤去しますか？</DialogTitle>
              <DialogDescription>
                撤去した株は地図に出なくなり、記録できなくなります。株コードは再利用しません
              </DialogDescription>
            </DialogHeader>
            <FormField id="mat-remove-reason" label="理由（任意）" hint={`例: 台風で倒れた、病気で抜いた（${MAX_REMOVE_REASON_LENGTH} 文字まで）`}>
              <Textarea
                id="mat-remove-reason"
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={MAX_REMOVE_REASON_LENGTH}
                data-testid="mat-remove-reason"
              />
            </FormField>
            {error && (
              <Alert variant="destructive" data-testid="mat-remove-error">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter className="flex-row gap-3">
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="flex-1"
                onClick={() => setOpen(false)}
                disabled={pending}
                data-testid="mat-remove-cancel"
              >
                やめる
              </Button>
              <Button
                type="submit"
                variant="destructive"
                size="lg"
                className="flex-1"
                disabled={pending}
                data-testid="mat-remove-submit"
              >
                {pending ? "撤去中…" : "撤去する"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
