"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  dueLabel,
  recommendationKindLabel,
  recordHref,
  targetLabel,
} from "@/lib/recommendations/display";
import { STANDARD_AMOUNT_MISSING } from "@/lib/recommendations/settings";
import { todayJst } from "@/lib/stemEvents";
import type { RecommendationListRow } from "./recommendations/data";
import { dismissRecommendation } from "./recommendation-actions";

// ホームの「提案」と /recommendations（3-4、screens.md 1）の一覧。行は期限順（サーバーで並べ替え済み）。
// 各行: 種類・対象（株コード・茎）・理由・期限、「実施した」（記録画面へ。袋掛けなら茎の画面の袋掛けのダイアログ）と「無視」。
// 「実施した」は記録画面を開くだけで、提案は対応するイベントが記録・同期された後の再計算で自動で done になる（事実が先）。
// 「無視」は確認してから dismissed にする（同じ提案は再び出ない）。
// 3-5: 収穫後の追肥の行は今の圃場の標準量（未設定なら「圃場の標準量を設定してください」と圃場の詳細へのリンク）を出す。
// total / allHref: ホームは上位の数件と「すべて見る（N 件）」（/recommendations）。省略すると全件の一覧
export function RecommendationList({
  rows,
  total,
  allHref,
}: {
  rows: RecommendationListRow[];
  total?: number;
  allHref?: string;
}) {
  const [confirming, setConfirming] = useState<RecommendationListRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const today = todayJst();

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground" data-testid="recommendations-empty">
        いまの提案はありません
      </p>
    );
  }

  return (
    <>
      <ul className="flex flex-col divide-y" data-testid="recommendation-list">
        {rows.map((r) => {
          const href = recordHref(r);
          return (
            <li
              key={r.id}
              className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
              data-testid="recommendation-row"
              data-id={r.id}
              data-kind={r.kind}
              data-stem-id={r.stem_id ?? ""}
              data-mat-id={r.mat_id ?? ""}
              data-target-type={r.target_type}
              data-due-at={r.due_at ?? ""}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge data-testid="recommendation-kind">{recommendationKindLabel(r.kind)}</Badge>
                <span className="font-semibold" data-testid="recommendation-target">
                  {targetLabel(r)}
                </span>
                {r.field_name && <span className="text-sm text-muted-foreground">{r.field_name}</span>}
              </div>
              {r.reason && <p data-testid="recommendation-reason">{r.reason}</p>}
              {r.amount_label && (
                <p data-testid="recommendation-amount" className={r.amount_label === STANDARD_AMOUNT_MISSING ? "text-muted-foreground" : undefined}>
                  {r.amount_label === STANDARD_AMOUNT_MISSING && r.field_id ? (
                    <Link href={`/fields/${r.field_id}#recommendation-settings`} className="underline underline-offset-4">
                      {r.amount_label}
                    </Link>
                  ) : (
                    r.amount_label
                  )}
                </p>
              )}
              <p className="text-sm text-muted-foreground" data-testid="recommendation-due">
                {dueLabel(r.due_at, today)}
              </p>
              <div className="grid grid-cols-2 gap-3">
                {href ? (
                  <Button asChild size="lg">
                    <Link href={href} data-testid="recommendation-done">
                      実施した
                    </Link>
                  </Button>
                ) : (
                  <span />
                )}
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  disabled={pending}
                  data-testid="recommendation-dismiss"
                  onClick={() => {
                    setError(null);
                    setConfirming(r);
                  }}
                >
                  無視
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {allHref && total !== undefined && total > rows.length && (
        <Button asChild variant="outline" className="mt-3 w-full">
          <Link href={allHref} data-testid="recommendations-all">
            すべて見る（{total} 件）
          </Link>
        </Button>
      )}
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirming(null);
        }}
      >
        <DialogContent showCloseButton={false} data-testid="recommendation-dismiss-dialog">
          <DialogHeader>
            <DialogTitle>提案を無視しますか？</DialogTitle>
            <DialogDescription>
              {confirming ? `${targetLabel(confirming)} の「${recommendationKindLabel(confirming.kind)}」` : ""}
              を一覧から外します。同じ提案は再び出ません
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive" data-testid="recommendation-dismiss-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" disabled={pending} onClick={() => setConfirming(null)}>
              やめる
            </Button>
            <Button
              type="button"
              size="lg"
              disabled={pending}
              data-testid="recommendation-dismiss-confirm"
              onClick={() => {
                const target = confirming;
                if (!target) return;
                startTransition(async () => {
                  const res = await dismissRecommendation(target.id);
                  if (res.ok) setConfirming(null);
                  else setError(res.error);
                });
              }}
            >
              {pending ? "保存中…" : "無視する"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
