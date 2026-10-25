"use client";

import { useMemo, useState } from "react";
import { LinkList, LinkListItem, LinkRow } from "@/components/app/link-list";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { cumulativeLeaves } from "@/lib/leaves";
import { applyOutboxToMat, matHoldKey, matServerIds, type MatStemRow } from "@/lib/offline/overlay";
import { useHeldItems } from "@/lib/offline/use-held-items";
import { useOutboxForStems } from "@/lib/offline/use-live-query";
import { generationLabel, sortStemsByGeneration, stemStatusLabel } from "@/lib/stems/status";
import { SuckerActions } from "./sucker-actions";
import { SuckerRecord } from "./sucker-record";

// 株の詳細の茎一覧と「吸芽が出た」（2-1）。サーバーから取得した茎（props）に、端末の outbox にある未送信分
// （吸芽の茎、葉の観測、茎の状態を変えるイベント）を重ねて表示する。未送信の吸芽は「未同期」の印付きで出し、
// サーバーにまだ無いので記録入力へのリンクにしない。同期が終わると SyncStatus が router.refresh() して props が最新になる。
// 吸芽の行には「採用」「芽かき」「株分け」（2-2、sucker-actions.tsx）。芽かき・株分けの茎は記録できないので、行は茎の画面
// （記録ボタンを出さず履歴だけを見せる。1-6）へのリンクだけ。
export function MatStems({ stems, canRecordSucker }: { stems: MatStemRow[]; canRecordSucker: boolean }) {
  const stemIds = useMemo(() => stems.map((s) => s.id), [stems]);
  const pending = useOutboxForStems(stemIds);
  // 茎・観測の id と、吸芽でなくなった茎の鍵（採用・芽かきの未送信分を、サーバーに反映されるまで保持するため）
  const serverIds = useMemo(() => matServerIds(stems), [stems]);
  const [notice, setNotice] = useState<string | null>(null);
  const held = useHeldItems(pending, serverIds, matHoldKey);
  const view = useMemo(() => sortStemsByGeneration(applyOutboxToMat(stems, [...pending, ...held])), [stems, pending, held]);
  const observedAts = useMemo(() => view.flatMap((s) => s.observations.map((o) => o.observed_at)), [view]);

  return (
    <>
      {notice && (
        <Alert variant="success" data-testid="sucker-action-notice">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {view.length === 0 ? (
        <p className="text-muted-foreground" data-testid="stems-empty">
          茎なし
        </p>
      ) : (
        <LinkList data-testid="stem-list">
          {view.map((s) => {
            const body = <StemRowBody stem={s} />;
            return (
              <LinkListItem
                key={s.id}
                data-testid="stem-item"
                data-stem-id={s.id}
                data-generation={s.generation}
                data-status={s.status}
                data-pending={s.pending ? "true" : undefined}
              >
                {s.pending ? (
                  <div className="flex min-h-14 items-center justify-between gap-3 px-4 py-2">{body}</div>
                ) : (
                  <LinkRow href={`/stems/${s.id}`} data-testid="stem-link" aria-label={`${generationLabel(s.generation)}の記録入力`}>
                    {body}
                  </LinkRow>
                )}
                {s.status === "sucker" && <SuckerActions stem={s} matStems={view} onDone={setNotice} />}
              </LinkListItem>
            );
          })}
        </LinkList>
      )}
      {canRecordSucker && <SuckerRecord stems={view} observedAts={observedAts} />}
    </>
  );
}

function StemRowBody({ stem }: { stem: MatStemRow }) {
  const leavesNew = stem.observations
    .filter((o) => o.type === "leaves_new")
    .map((o) => ({ type: "leaves_new" as const, value: Number(o.value), observedAt: new Date(o.observed_at) }));
  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{generationLabel(stem.generation)}</span>
        <span className="text-sm text-muted-foreground">第 {stem.generation} 世代</span>
        {stem.pending && (
          <Badge variant="outline" className="border-warning-foreground/40 bg-warning text-warning-foreground" data-testid="stem-pending">
            未同期
          </Badge>
        )}
      </span>
      <span className="flex flex-col items-end text-sm text-muted-foreground">
        <span data-testid="stem-status">{stemStatusLabel(stem.status)}</span>
        {stem.status === "sucker" ? (
          <span data-testid="stem-started-at">{stem.started_at} 確認</span>
        ) : (
          <span>
            累計葉数{" "}
            <span className="text-base font-semibold text-foreground" data-testid="stem-cumulative-leaves">
              {cumulativeLeaves(stem.initial_leaf_count, leavesNew)}
            </span>{" "}
            枚
          </span>
        )}
      </span>
    </>
  );
}
