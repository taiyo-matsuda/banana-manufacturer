"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { MatSelectList, SimpleMatSelectRow, useMatExclusion } from "@/components/app/mat-select-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { bulkDamageKey, bulkDamageSummaryText, NO_TARGET_MESSAGE, selectedMatIds } from "@/lib/damage";
import { useOnline } from "@/lib/offline/use-online";
import { recordBulkMatDamage } from "../actions";

type MatItem = { id: string; code: string };

const OFFLINE_MESSAGE = "株への被害の記録は電波のあるところで行ってください（株の数が多いため端末に貯めません）";

// 圃場の被害から株へ一括（2-5）のフォーム。株の一覧は施肥（2-4）と共通の部品（mat-select-list.tsx）。
// - 選択（外した株）は React の state。Server Action は関数として呼ぶので、エラーで戻っても選択は消えない
// - 確定は画面下部の固定ボタン → 確認ダイアログ「N 株に被害を記録」→ recordBulkMatDamage
// - batch_id は確定の内容（対象の株）ごとに 1 つ。成功するまで保持し、同じ内容の再送では同じ batch_id を送る
//   （確認ダイアログを開くたびに作り直さない。サーバーは同じ batch_id があれば insert しない）
// - 圏外なら確定ボタンを無効にして理由を出す
export function BulkDamageForm({
  fieldId,
  fieldEventId,
  mats,
  alreadyCount,
}: {
  fieldId: string;
  fieldEventId: string;
  mats: MatItem[];
  alreadyCount: number;
}) {
  const online = useOnline();
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<{ targets?: string; form?: string }>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const batch = useRef<{ id: string; key: string } | null>(null);

  const clearServerErrors = useCallback(() => setServerErrors((e) => (Object.keys(e).length === 0 ? e : {})), []);
  const { excluded, toggle, selectAll, selectNone } = useMatExclusion(clearServerErrors);
  const matIds = useMemo(() => mats.map((m) => m.id), [mats]);
  const targets = useMemo(() => selectedMatIds(matIds, excluded), [matIds, excluded]);

  const firstError = serverErrors.targets ?? (targets.length === 0 ? NO_TARGET_MESSAGE : null);

  const openConfirm = () => {
    setShowErrors(true);
    if (!online || targets.length === 0) return;
    const key = bulkDamageKey({ fieldId, fieldEventId, matIds: targets });
    if (batch.current?.key !== key) batch.current = { id: crypto.randomUUID(), key };
    setConfirmOpen(true);
  };

  const submit = async () => {
    if (pending || !batch.current) return;
    setPending(true);
    try {
      const result = await recordBulkMatDamage({ batchId: batch.current.id, fieldId, fieldEventId, matIds: targets });
      if (!result.ok) {
        // 検証エラー（何も記録されていない）。直して送り直すときは新しい batch_id にする
        batch.current = null;
        setServerErrors(result.errors);
        setConfirmOpen(false);
        return;
      }
      batch.current = null;
      setConfirmOpen(false);
      setDone(result.count);
    } catch (err) {
      // 通信エラー: サーバーで記録済みかもしれないので batch_id は保持する（同じ内容の再送は 1 回分になる）
      console.error("record bulk damage failed", err);
      setServerErrors({ form: "保存できませんでした。通信を確かめて再度お試しください" });
      setConfirmOpen(false);
    } finally {
      setPending(false);
    }
  };

  if (done !== null) {
    return (
      <Card data-testid="damage-bulk-done">
        <CardHeader>
          <CardTitle>株に被害を記録しました</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p data-testid="damage-bulk-done-summary">{done} 株に記録しました</p>
          <Button asChild size="lg">
            <Link href={`/fields/${fieldId}`} data-testid="damage-bulk-done-field">
              圃場の詳細へ
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      data-testid="damage-bulk-form"
      onSubmit={(e) => {
        e.preventDefault();
        openConfirm();
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>対象の株</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {alreadyCount > 0 && (
            <p className="text-sm text-muted-foreground" data-testid="damage-bulk-already">
              この圃場の被害から記録済みの {alreadyCount} 株は一覧に出していません
            </p>
          )}
          <MatSelectList
            testIdPrefix="damage-bulk"
            matIds={matIds}
            emptyText={alreadyCount > 0 ? "記録できる株は残っていません" : "この圃場には株がありません"}
            onSelectAll={selectAll}
            onSelectNone={selectNone}
            summary={
              <>
                対象 <span data-testid="damage-bulk-count">{targets.length}</span> / {mats.length} 株
              </>
            }
          >
            {mats.map((m) => (
              <SimpleMatSelectRow
                key={m.id}
                testIdPrefix="damage-bulk"
                id={m.id}
                code={m.code}
                included={!excluded.has(m.id)}
                onToggle={toggle}
              />
            ))}
          </MatSelectList>
        </CardContent>
      </Card>

      {/* 画面下部の固定ボタン（下部タブの上）の分の余白 */}
      <div className="h-28" aria-hidden="true" />

      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t bg-background/95 px-4 py-3 backdrop-blur supports-backdrop-filter:bg-background/80">
        <div className="mx-auto flex max-w-md flex-col gap-2">
          {serverErrors.form && (
            <p role="alert" className="text-sm font-medium text-destructive" data-testid="damage-bulk-error">
              {serverErrors.form}
            </p>
          )}
          {!online ? (
            <p className="text-sm text-muted-foreground" data-testid="damage-bulk-offline">
              {OFFLINE_MESSAGE}
            </p>
          ) : (
            showErrors &&
            firstError && (
              <p role="alert" className="text-sm font-medium text-destructive" data-testid="damage-bulk-invalid">
                {firstError}
              </p>
            )
          )}
          <Button
            type="submit"
            size="lg"
            className="w-full"
            disabled={!online || pending || mats.length === 0}
            data-testid="damage-bulk-submit"
          >
            {targets.length > 0 ? `確定（${bulkDamageSummaryText(targets.length)}）` : "確定"}
          </Button>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={(o) => !pending && setConfirmOpen(o)}>
        <DialogContent showCloseButton={false} data-testid="damage-bulk-confirm-dialog">
          <DialogHeader>
            <DialogTitle>株に被害を記録しますか？</DialogTitle>
            <DialogDescription data-testid="damage-bulk-confirm-summary">
              {bulkDamageSummaryText(targets.length)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row gap-3">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="flex-1"
              onClick={() => setConfirmOpen(false)}
              disabled={pending}
              data-testid="damage-bulk-confirm-cancel"
            >
              やめる
            </Button>
            <Button
              type="button"
              size="lg"
              className="flex-1"
              onClick={() => void submit()}
              disabled={pending}
              data-testid="damage-bulk-confirm-submit"
            >
              {pending ? "記録中…" : "記録する"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}
