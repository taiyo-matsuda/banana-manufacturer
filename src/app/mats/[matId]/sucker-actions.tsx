"use client";

import { useState } from "react";
import Link from "next/link";
import { NumberField } from "@/components/app/number-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { enqueueAdoptSucker, enqueueRemoveSucker } from "@/lib/offline/enqueue";
import type { MatStemRow } from "@/lib/offline/overlay";
import { useOnline } from "@/lib/offline/use-online";
import { canAdoptSucker, parseRequiredInitialLeafCount } from "@/lib/stemEvents";
import { generationLabel } from "@/lib/stems/status";

// 吸芽の茎の「採用」「芽かき」「株分け」（2-2、要件 3 章「吸芽の扱い」・UC-4、画面 3）。株の詳細の茎一覧の吸芽の行の下に出す。
// - 採用: 初期葉数を入れて確定 → outbox（RPC adopt_sucker、0011。id で冪等）。栽培中が 3 本ならボタンを無効にして理由を表示
//   （DB のトリガーが正本。画面を開いた後に 3 本になった場合は同期が要確認になり、理由が同期の画面に出る）
// - 芽かき: 確認ダイアログ → outbox（RPC remove_sucker）
// - 株分け: 株の作成を伴うのでオンラインのみ。株分けの画面（/stems/[stemId]/transplant）へ。オフラインなら無効にして理由を表示
// 未同期の吸芽（サーバーにまだ無い）は操作できない（同期後に操作する）。
export function SuckerActions({
  stem,
  matStems,
  onDone,
}: {
  stem: MatStemRow;
  matStems: MatStemRow[];
  onDone: (message: string) => void;
}) {
  const online = useOnline();
  const [dialog, setDialog] = useState<"adopt" | "remove" | null>(null);
  const [opened, setOpened] = useState(0);
  const adopt = canAdoptSucker(stem, matStems);
  const name = `${generationLabel(stem.generation)}（第 ${stem.generation} 世代）の吸芽`;

  if (stem.pending) {
    return (
      <p className="px-4 pb-3 text-sm text-muted-foreground" data-testid="sucker-actions-pending">
        同期が終わると採用・芽かき・株分けができます
      </p>
    );
  }

  const open = (d: "adopt" | "remove") => {
    setOpened((n) => n + 1);
    setDialog(d);
  };

  return (
    <div className="flex flex-col gap-2 px-4 pb-3" data-testid="sucker-actions">
      <div className="grid grid-cols-3 gap-2">
        <Button type="button" disabled={!adopt.ok} onClick={() => open("adopt")} data-testid="sucker-adopt-open">
          採用
        </Button>
        <Button type="button" variant="outline" onClick={() => open("remove")} data-testid="sucker-remove-open">
          芽かき
        </Button>
        {online ? (
          <Button asChild variant="outline">
            <Link href={`/stems/${stem.id}/transplant`} data-testid="sucker-transplant-open">
              株分け
            </Link>
          </Button>
        ) : (
          <Button type="button" variant="outline" disabled data-testid="sucker-transplant-open">
            株分け
          </Button>
        )}
      </div>
      {!adopt.ok && (
        <p className="text-sm text-muted-foreground" data-testid="sucker-adopt-blocked">
          {adopt.reason}
        </p>
      )}
      {!online && (
        <p className="text-sm text-muted-foreground" data-testid="sucker-transplant-offline">
          株分けは新しい株を作るため、オンラインのときだけできます
        </p>
      )}

      <Sheet open={dialog === "adopt"} onOpenChange={(o) => !o && setDialog(null)}>
        <SheetContent side="bottom" className="max-h-[90vh] overflow-y-auto" data-testid="sucker-adopt-sheet">
          <AdoptForm
            key={opened}
            stemId={stem.id}
            name={name}
            onDone={() => {
              setDialog(null);
              onDone("吸芽を採用しました");
            }}
            onCancel={() => setDialog(null)}
          />
        </SheetContent>
      </Sheet>

      <Dialog open={dialog === "remove"} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent showCloseButton={false} data-testid="sucker-remove-dialog">
          <RemoveConfirm
            key={opened}
            stemId={stem.id}
            name={name}
            onDone={() => {
              setDialog(null);
              onDone("吸芽を芽かきしました");
            }}
            onCancel={() => setDialog(null)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AdoptForm({ stemId, name, onDone, onCancel }: { stemId: string; name: string; onDone: () => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (pending) return;
    const parsed = parseRequiredInitialLeafCount(value);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setPending(true);
    try {
      await enqueueAdoptSucker({ stemId, occurredAt: new Date().toISOString(), initialLeafCount: parsed.value });
      setError(null);
      onDone();
    } catch (err) {
      console.error("adopt enqueue failed", err);
      setError("端末に保存できませんでした。時間をおいて再度お試しください");
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
      className="flex flex-col gap-4"
    >
      <SheetHeader className="pb-0">
        <SheetTitle className="text-lg">吸芽を採用</SheetTitle>
        <SheetDescription>{name}を栽培中の茎にします。累計葉数は初期葉数から数え始めます</SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 px-4">
        <NumberField
          id="sucker-adopt-leaves"
          label="初期葉数"
          unit="枚"
          min={0}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          data-testid="sucker-adopt-leaves"
        />
        {error && (
          <Alert variant="destructive" data-testid="sucker-adopt-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
      <SheetFooter className="flex-row gap-3 pt-0">
        <Button type="button" variant="outline" size="lg" className="flex-1" onClick={onCancel} disabled={pending} data-testid="sucker-adopt-cancel">
          やめる
        </Button>
        <Button type="submit" size="lg" className="flex-1" disabled={pending} data-testid="sucker-adopt-submit">
          {pending ? "記録中…" : "採用する"}
        </Button>
      </SheetFooter>
    </form>
  );
}

function RemoveConfirm({ stemId, name, onDone, onCancel }: { stemId: string; name: string; onDone: () => void; onCancel: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (pending) return;
    setPending(true);
    try {
      await enqueueRemoveSucker({ stemId, occurredAt: new Date().toISOString() });
      setError(null);
      onDone();
    } catch (err) {
      console.error("remove enqueue failed", err);
      setError("端末に保存できませんでした。時間をおいて再度お試しください");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>芽かきしますか？</DialogTitle>
        <DialogDescription>{name}を芽かきとして記録します。芽かきした吸芽には記録できなくなります</DialogDescription>
      </DialogHeader>
      {error && (
        <Alert variant="destructive" data-testid="sucker-remove-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <DialogFooter className="flex-row gap-3">
        <Button type="button" variant="outline" size="lg" className="flex-1" onClick={onCancel} disabled={pending} data-testid="sucker-remove-cancel">
          やめる
        </Button>
        <Button type="button" variant="destructive" size="lg" className="flex-1" onClick={() => void submit()} disabled={pending} data-testid="sucker-remove-submit">
          {pending ? "記録中…" : "芽かきする"}
        </Button>
      </DialogFooter>
    </div>
  );
}
