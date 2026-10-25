"use client";

import { memo, useCallback, useState } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

// 圃場の株の一覧から対象を選ぶ部品（施肥の一括入力 2-4 と、圃場の被害から株への一括 2-5 で共通）。
// - 既定は全株が対象。外した株を Set で持つ（行ごとの state を作らない。400 株でも軽く）
// - 「全て選択」「全て外す」と、行ごとのチェック（行の株コードもタップ領域。高さ 48px 以上）
// - data-testid は `${testIdPrefix}-...`（施肥は "fertilize"）。行は `-mat-row`（data-code / data-included）、
//   チェックは `-mat-check`、一覧は `-mat-list`、ボタンは `-select-all` / `-select-none`

export type SelectableMat = { id: string; code: string };

// 外した株の状態と操作。onChange は選択が変わるたびに呼ばれる（画面側でサーバーのエラー表示を消すなど）
export function useMatExclusion(onChange?: () => void) {
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (id: string, include: boolean) => {
      onChange?.();
      setExcluded((prev) => {
        if (include === !prev.has(id)) return prev;
        const next = new Set(prev);
        if (include) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [onChange],
  );
  const selectAll = useCallback(() => {
    onChange?.();
    setExcluded(new Set());
  }, [onChange]);
  const selectNone = useCallback(
    (ids: readonly string[]) => {
      onChange?.();
      setExcluded(new Set(ids));
    },
    [onChange],
  );
  return { excluded, toggle, selectAll, selectNone };
}

// 一覧の枠: 概要（対象 N / M 株など）＋全て選択 / 全て外す＋行（children）
export function MatSelectList({
  testIdPrefix,
  matIds,
  summary,
  emptyText = "この圃場には株がありません",
  onSelectAll,
  onSelectNone,
  children,
}: {
  testIdPrefix: string;
  matIds: readonly string[];
  summary: React.ReactNode;
  emptyText?: string;
  onSelectAll: () => void;
  onSelectNone: (ids: readonly string[]) => void;
  children: React.ReactNode;
}) {
  if (matIds.length === 0) {
    return (
      <p className="text-muted-foreground" data-testid={`${testIdPrefix}-no-mats`}>
        {emptyText}
      </p>
    );
  }
  return (
    <>
      <p className="tabular-nums" data-testid={`${testIdPrefix}-summary`}>
        {summary}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" onClick={onSelectAll} data-testid={`${testIdPrefix}-select-all`}>
          全て選択
        </Button>
        <Button type="button" variant="outline" onClick={() => onSelectNone(matIds)} data-testid={`${testIdPrefix}-select-none`}>
          全て外す
        </Button>
      </div>
      <ul className="flex flex-col divide-y" data-testid={`${testIdPrefix}-mat-list`}>
        {children}
      </ul>
    </>
  );
}

// 1 行: チェック＋株コード（＋任意の印 badge）と、右側の任意の部品（trailing）、行の下の任意の部品（below）。
// memo しない（施肥の行のように右側の部品を持つ画面は、呼び出し側の行を memo する）。
// 右側の部品がない一覧は SimpleMatSelectRow（memo 済み）を使う
export function MatSelectRow({
  testIdPrefix,
  id,
  code,
  included,
  onToggle,
  highlighted = false,
  badge,
  trailing,
  below,
  dataAttributes,
}: {
  testIdPrefix: string;
  id: string;
  code: string;
  included: boolean;
  onToggle: (id: string, include: boolean) => void;
  highlighted?: boolean;
  badge?: React.ReactNode;
  trailing?: React.ReactNode;
  below?: React.ReactNode;
  dataAttributes?: Record<`data-${string}`, string | undefined>;
}) {
  const checkboxId = `${testIdPrefix}-mat-${id}`;
  return (
    <li
      // 画面外の行は描画（レイアウト・ペイント）を省く（400 株でも入力で詰まらないように）
      className={cn(
        "flex flex-col gap-1 py-2 [contain-intrinsic-size:auto_64px] [content-visibility:auto]",
        highlighted && included && "-mx-2 rounded-lg bg-accent px-2",
        !included && "text-muted-foreground",
      )}
      data-testid={`${testIdPrefix}-mat-row`}
      data-code={code}
      data-included={included ? "true" : "false"}
      {...dataAttributes}
    >
      <div className="flex items-center gap-2">
        <label htmlFor={checkboxId} className="flex min-h-12 min-w-0 flex-1 cursor-pointer items-center gap-3">
          <Checkbox
            id={checkboxId}
            checked={included}
            onChange={(e) => onToggle(id, e.target.checked)}
            aria-label={`株 ${code} を対象にする`}
            data-testid={`${testIdPrefix}-mat-check`}
          />
          <span className="flex min-w-0 flex-col items-start">
            <span className={cn("max-w-full truncate font-mono text-base", !included && "line-through")}>{code}</span>
            {badge}
          </span>
        </label>
        {trailing}
      </div>
      {below}
    </li>
  );
}

export const SimpleMatSelectRow = memo(function SimpleMatSelectRow(props: {
  testIdPrefix: string;
  id: string;
  code: string;
  included: boolean;
  onToggle: (id: string, include: boolean) => void;
}) {
  return <MatSelectRow {...props} />;
});
