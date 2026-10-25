"use client";

import { useMemo, useSyncExternalStore } from "react";
import Link from "next/link";
import { FlowerIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { hasIndexedDb } from "@/lib/db";
import { useHeldItems } from "@/lib/offline/use-held-items";
import { useOutbox } from "@/lib/offline/use-live-query";
import type { OutboxItem } from "@/lib/offline/types";
import { todayJst } from "@/lib/stemEvents";
import { stemStatusLabel } from "@/lib/stems/status";
import {
  applyOutboxToWeekly,
  computeWeekly,
  DEFAULT_WEEKLY_THRESHOLD,
  daysSinceLabel,
  parseWeeklyThreshold,
  WEEKLY_THRESHOLD_KEY,
  WEEKLY_THRESHOLDS,
  weeklyHoldKey,
  weeklyServerKeys,
  type WeeklyStemRow,
} from "@/lib/weekly";
import { useStoredValue, writeItem } from "./device-store";
import { LinkList, LinkListItem, LinkRow } from "./link-list";

// 今週見る株（2-7、画面 1）の一覧。ホームと /weekly で共通。
// - サーバーは茎ごとの行（view weekly_stems）を渡す。並べ替え・閾値・今日の除外は src/lib/weekly.ts の純粋関数
// - 未同期（outbox）の葉数の記録を重ねる（圏外で +1 を記録してホームに戻っても消える。1-9 の重ね合わせ）。
//   送信済みで outbox から消えたがサーバーの行にまだ無い記録は useHeldItems で保持する
// - 閾値（7 日 / 14 日）は端末の localStorage。サーバー描画は既定の 7 日で、切り替えたらクライアントで再計算する
const EMPTY: OutboxItem[] = [];

// ハイドレーションが済んだか（サーバー描画と最初のクライアント描画は false）
const noopSubscribe = () => () => {};
function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

export function WeeklyThresholdToggle() {
  const threshold = useStoredValue(WEEKLY_THRESHOLD_KEY, parseWeeklyThreshold, DEFAULT_WEEKLY_THRESHOLD);
  return (
    <div className="flex gap-2" role="group" aria-label="経過日数の閾値" data-testid="weekly-threshold">
      {WEEKLY_THRESHOLDS.map((t) => (
        <Button
          key={t}
          type="button"
          size="sm"
          className="text-base"
          variant={threshold === t ? "default" : "outline"}
          aria-pressed={threshold === t}
          data-testid={`weekly-threshold-${t}`}
          onClick={() => writeItem(WEEKLY_THRESHOLD_KEY, String(t))}
        >
          {t} 日
        </Button>
      ))}
    </div>
  );
}

export function WeeklyList({
  rows,
  limit,
  allHref = "/weekly",
}: {
  rows: WeeklyStemRow[];
  // ホームは最初の limit 件と「すべて見る（N 件）」。省略すると全件
  limit?: number;
  allHref?: string;
}) {
  const threshold = useStoredValue(WEEKLY_THRESHOLD_KEY, parseWeeklyThreshold, DEFAULT_WEEKLY_THRESHOLD);
  const hydrated = useHydrated();
  const outboxOrNull = useOutbox();
  const outbox = outboxOrNull ?? EMPTY;
  const serverKeys = useMemo(() => weeklyServerKeys(rows), [rows]);
  const held = useHeldItems(outbox, serverKeys, weeklyHoldKey);
  const items = useMemo(
    () => computeWeekly(applyOutboxToWeekly(rows, [...held, ...outbox]), todayJst(), threshold),
    [rows, held, outbox, threshold],
  );
  const shown = limit === undefined ? items : items.slice(0, limit);

  // 端末の閾値（localStorage）と未同期の記録（IndexedDB）を読むまでは一覧を出さない
  // （14 日を保存した端末で 7 日の一覧が一瞬出る・圏外で記録した株が一瞬出る、のを避ける。行のデータは届いているので一瞬で出る）
  if (!hydrated || (outboxOrNull === null && hasIndexedDb())) {
    // 文字は出さない（クライアント遷移で非表示のまま残った前の画面に「読み込み中…」が残ると紛らわしい）。高さは 1 行分
    return <div className="min-h-14" aria-busy="true" data-testid="weekly-loading" />;
  }

  return (
    <div className="flex flex-col gap-3" data-testid="weekly-list" data-threshold={threshold} data-count={items.length}>
      {items.length === 0 ? (
        <p className="text-muted-foreground" data-testid="weekly-empty">
          今週見る株はありません
        </p>
      ) : (
        <LinkList>
          {shown.map((item) => (
            <LinkListItem
              key={item.matId}
              data-testid="weekly-row"
              data-mat-code={item.matCode}
              data-flowered={item.flowered ? "true" : "false"}
            >
              <LinkRow href={`/mats/${item.matId}`}>
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-lg font-medium" data-testid="weekly-mat-code">
                      {item.matCode}
                    </span>
                    {item.flowered && (
                      <Badge data-testid="weekly-flowered">
                        <FlowerIcon aria-hidden="true" />
                        出蕾
                      </Badge>
                    )}
                  </span>
                  <span className="truncate text-sm text-muted-foreground" data-testid="weekly-field-name">
                    {item.fieldName}
                  </span>
                  <span data-testid="weekly-stem">
                    {stemStatusLabel(item.stemStatus)}・累計 {item.cumulativeLeaves} 枚
                  </span>
                </span>
                <span className="shrink-0 text-sm text-muted-foreground" data-testid="weekly-days">
                  {daysSinceLabel(item.daysSince)}
                </span>
              </LinkRow>
            </LinkListItem>
          ))}
        </LinkList>
      )}
      {limit !== undefined && items.length > 0 && (
        <Button asChild variant="outline">
          <Link href={allHref} data-testid="weekly-all">
            すべて見る（{items.length} 件）
          </Link>
        </Button>
      )}
    </div>
  );
}
