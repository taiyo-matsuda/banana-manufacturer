"use client";

import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { RotateCcwIcon } from "lucide-react";
import { cn } from "cn";
import { FormField } from "@/components/app/form-field";
import { MatSelectList, MatSelectRow, useMatExclusion } from "@/components/app/mat-select-list";
import { NumberField } from "@/components/app/number-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  buildFertilizePlan,
  FERTILIZER_UNITS,
  fertilizeSubmissionKey,
  fertilizeSummaryText,
  formatAmount,
  NO_TARGET_MESSAGE,
  parseFertilizeDate,
  parseFertilizerName,
  type SubmissionErrors,
} from "@/lib/fertilize";
import { useOnline } from "@/lib/offline/use-online";
import { recordFertilization } from "./actions";

type MatItem = { id: string; code: string };

// 候補をボタンで出す数（残りは入力欄の候補リスト datalist で出す）
const SUGGESTION_CHIPS = 5;

const OFFLINE_MESSAGE = "施肥の記録は電波のあるところで行ってください（株の数が多いため端末に貯めません）";

// 施肥の一括入力のフォーム（2-4、画面 5）。
// - 入力（日付・肥料名・量・単位）と、株ごとの選択・個別の量はすべて React の state で持つ（制御コンポーネント）。
//   Server Action は関数として呼ぶので、エラーで戻っても入力・選択・個別の量は消えない（React 19 のフォームリセットを受けない）
// - 400 株程度でも重くならないように: 行は memo し、コールバックは安定させる。外した株は Set、量を個別に変えた株は
//   Map で持つ（行ごとの state を作らない）。個別に変えていない行は「上の量」を表示するだけなので、上の量を変えると
//   追従する。上の量は useDeferredValue で行に渡し、入力中の打鍵を一覧の再描画で詰まらせない
// - 確定は画面下部の固定ボタン → 確認ダイアログ「N 株に合計 X kg」→ recordFertilization。圏外ならボタンを無効にして理由を出す
export function FertilizeForm({
  fieldId,
  mats,
  suggestions,
  defaultUnit,
  today,
}: {
  fieldId: string;
  mats: MatItem[];
  suggestions: string[];
  defaultUnit: string;
  today: string;
}) {
  const router = useRouter();
  const online = useOnline();

  const [date, setDate] = useState(today);
  const [fertilizer, setFertilizer] = useState("");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState(defaultUnit);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, string>>(() => new Map());
  // 確定を 1 回押すまではエラーを出さない（入力途中で赤くしない）
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<SubmissionErrors>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<{ count: number; total: number; unit: string; fertilizer: string } | null>(null);
  // 確定ごとの batch_id。送信が成功するまで保持し、同じ内容の再送（応答が届かなかった場合）では同じ batch_id を送る
  // （サーバーは同じ batch_id が既にあれば insert しない = 二重記録しない）。内容（日付・肥料名・単位・対象・量）が
  // 変わったとき、成功したとき、サーバーの検証エラーで戻ったときだけ採番し直す
  const batch = useRef<{ id: string; key: string } | null>(null);

  const clearServerErrors = useCallback(() => setServerErrors((e) => (Object.keys(e).length === 0 ? e : {})), []);
  // 外した株（株の一覧は圃場の被害の一括 2-5 と共通の部品 mat-select-list.tsx）
  const { excluded, toggle, selectAll, selectNone } = useMatExclusion(clearServerErrors);

  const matIds = useMemo(() => mats.map((m) => m.id), [mats]);
  const deferredAmount = useDeferredValue(amount);

  const plan = useMemo(
    () => buildFertilizePlan({ matIds, excluded, overrides, baseAmount: amount }),
    [matIds, excluded, overrides, amount],
  );
  const dateCheck = parseFertilizeDate(date, new Date(`${today}T12:00:00+09:00`));
  const nameCheck = parseFertilizerName(fertilizer);

  const errors = {
    date: serverErrors.date ?? (dateCheck.ok ? null : dateCheck.error),
    fertilizer: serverErrors.fertilizer ?? (nameCheck.ok ? null : nameCheck.error),
    amount: plan.baseError,
    unit: serverErrors.unit ?? null,
    targets: serverErrors.targets ?? (plan.selectedCount === 0 ? NO_TARGET_MESSAGE : plan.rowErrors.size > 0 ? "量が正しくない株があります（赤い行）" : null),
  };
  const firstError = errors.date ?? errors.fertilizer ?? errors.amount ?? errors.unit ?? errors.targets;
  const valid = dateCheck.ok && nameCheck.ok && plan.baseError === null && plan.rowErrors.size === 0 && plan.selectedCount > 0;

  const setOverride = useCallback(
    (id: string, text: string) => {
      clearServerErrors();
      setOverrides((prev) => new Map(prev).set(id, text));
    },
    [clearServerErrors],
  );
  const resetOverride = useCallback((id: string) => {
    setOverrides((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const openConfirm = () => {
    setShowErrors(true);
    if (!online || !valid || plan.total === null) return;
    const key = fertilizeSubmissionKey({ fieldId, date, fertilizer, unit, items: plan.items });
    if (batch.current?.key !== key) batch.current = { id: crypto.randomUUID(), key };
    setConfirmOpen(true);
  };

  const submit = async () => {
    if (pending || plan.total === null) return;
    setPending(true);
    try {
      const result = await recordFertilization({
        batchId: batch.current?.id ?? crypto.randomUUID(),
        fieldId,
        date,
        fertilizer,
        unit,
        items: plan.items,
      });
      if (!result.ok) {
        // 検証エラー（何も記録されていない）。直して送り直すときは新しい batch_id にする
        batch.current = null;
        setServerErrors(result.errors);
        setConfirmOpen(false);
        return;
      }
      batch.current = null;
      setConfirmOpen(false);
      setDone({ count: result.count, total: result.total, unit, fertilizer: fertilizer.trim() });
      // 肥料名の候補・単位の既定値を取り直す（入力中の state はそのまま）
      router.refresh();
    } catch (err) {
      // 通信エラー: サーバーで記録済みかもしれないので batch_id は保持する（同じ内容の再送は 1 回分になる）
      console.error("record fertilization failed", err);
      setServerErrors({ form: "保存できませんでした。通信を確かめて再度お試しください" });
      setConfirmOpen(false);
    } finally {
      setPending(false);
    }
  };

  const startNext = () => {
    setDone(null);
    selectAll();
    setOverrides(new Map());
    setShowErrors(false);
    setServerErrors({});
  };

  if (done) {
    return (
      <Card data-testid="fertilize-done">
        <CardHeader>
          <CardTitle>施肥を記録しました</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p data-testid="fertilize-done-summary">
            {done.fertilizer}: {fertilizeSummaryText(done.count, done.total, done.unit)}
          </p>
          <Button asChild size="lg">
            <Link href={`/fields/${fieldId}`} data-testid="fertilize-done-field">
              圃場の詳細へ
            </Link>
          </Button>
          <Button type="button" variant="outline" size="lg" onClick={startNext} data-testid="fertilize-again">
            続けて記録する
          </Button>
        </CardContent>
      </Card>
    );
  }

  const shownError = (e: string | null) => (showErrors ? e : null);
  const totalText = plan.total === null ? "—" : `${formatAmount(plan.total)} ${unit}`;

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      data-testid="fertilize-form"
      onSubmit={(e) => {
        e.preventDefault();
        openConfirm();
      }}
    >
      <Card>
        <CardContent className="flex flex-col gap-4">
          <FormField id="fertilize-date" label="日付" error={shownError(errors.date)}>
            <Input
              id="fertilize-date"
              type="date"
              value={date}
              max={today}
              onChange={(e) => {
                clearServerErrors();
                setDate(e.target.value);
              }}
              aria-invalid={showErrors && errors.date ? true : undefined}
              data-testid="fertilize-date"
            />
          </FormField>

          <FormField
            id="fertilize-name"
            label="肥料名"
            hint={suggestions.length > 0 ? "前に使った肥料名から選ぶか、入力してください" : "例: 化成肥料 8-8-8"}
            error={shownError(errors.fertilizer)}
          >
            <Input
              id="fertilize-name"
              value={fertilizer}
              list="fertilize-name-suggestions"
              autoComplete="off"
              onChange={(e) => {
                clearServerErrors();
                setFertilizer(e.target.value);
              }}
              aria-invalid={showErrors && errors.fertilizer ? true : undefined}
              data-testid="fertilize-name"
            />
            <datalist id="fertilize-name-suggestions" data-testid="fertilize-name-datalist">
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-2" data-testid="fertilize-suggestions">
                {suggestions.slice(0, SUGGESTION_CHIPS).map((s) => (
                  <Button
                    key={s}
                    type="button"
                    variant={fertilizer.trim() === s ? "secondary" : "outline"}
                    className="max-w-full"
                    onClick={() => {
                      clearServerErrors();
                      setFertilizer(s);
                    }}
                    data-testid="fertilize-suggestion"
                  >
                    <span className="truncate">{s}</span>
                  </Button>
                ))}
              </div>
            )}
          </FormField>

          <div className="grid grid-cols-[1fr_auto] items-start gap-3">
            <NumberField
              id="fertilize-amount"
              label="量（1 株あたり）"
              inputMode="decimal"
              step="any"
              min="0"
              value={amount}
              onChange={(e) => {
                clearServerErrors();
                setAmount(e.target.value);
              }}
              error={shownError(errors.amount)}
              data-testid="fertilize-amount"
            />
            <FormField id="fertilize-unit" label="単位" error={shownError(errors.unit)}>
              <NativeSelect
                id="fertilize-unit"
                className="w-28"
                value={unit}
                onChange={(e) => {
                  clearServerErrors();
                  setUnit(e.target.value);
                }}
                data-testid="fertilize-unit"
              >
                {FERTILIZER_UNITS.map((u) => (
                  <NativeSelectOption key={u} value={u}>
                    {u}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>対象の株</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <MatSelectList
            testIdPrefix="fertilize"
            matIds={matIds}
            onSelectAll={selectAll}
            onSelectNone={selectNone}
            summary={
              <>
                対象 <span data-testid="fertilize-count">{plan.selectedCount}</span> / {mats.length} 株・合計{" "}
                <span data-testid="fertilize-total">{totalText}</span>
              </>
            }
          >
            {mats.map((m) => {
              const override = overrides.get(m.id);
              return (
                <MatRow
                  key={m.id}
                  id={m.id}
                  code={m.code}
                  included={!excluded.has(m.id)}
                  override={override}
                  // 個別に変えた行には上の量を渡さない（上の量を変えても再描画しない）
                  baseAmount={override === undefined ? deferredAmount : ""}
                  unit={unit}
                  error={showErrors && !excluded.has(m.id) ? (plan.rowErrors.get(m.id) ?? null) : null}
                  onToggle={toggle}
                  onOverride={setOverride}
                  onReset={resetOverride}
                />
              );
            })}
          </MatSelectList>
        </CardContent>
      </Card>

      {/* 画面下部の固定ボタン（下部タブの上）の分の余白 */}
      <div className="h-28" aria-hidden="true" />

      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t bg-background/95 px-4 py-3 backdrop-blur supports-backdrop-filter:bg-background/80">
        <div className="mx-auto flex max-w-md flex-col gap-2">
          {serverErrors.form && (
            <p role="alert" className="text-sm font-medium text-destructive" data-testid="fertilize-error">
              {serverErrors.form}
            </p>
          )}
          {!online ? (
            <p className="text-sm text-muted-foreground" data-testid="fertilize-offline">
              {OFFLINE_MESSAGE}
            </p>
          ) : (
            showErrors &&
            firstError && (
              <p role="alert" className="text-sm font-medium text-destructive" data-testid="fertilize-invalid">
                {firstError}
              </p>
            )
          )}
          <Button type="submit" size="lg" className="w-full" disabled={!online || pending} data-testid="fertilize-submit">
            {plan.selectedCount > 0 && plan.total !== null
              ? `確定（${fertilizeSummaryText(plan.selectedCount, plan.total, unit)}）`
              : "確定"}
          </Button>
        </div>
      </div>

      <Dialog open={confirmOpen} onOpenChange={(o) => !pending && setConfirmOpen(o)}>
        <DialogContent showCloseButton={false} data-testid="fertilize-confirm-dialog">
          <DialogHeader>
            <DialogTitle>施肥を記録しますか？</DialogTitle>
            <DialogDescription data-testid="fertilize-confirm-summary">
              {plan.total !== null ? fertilizeSummaryText(plan.selectedCount, plan.total, unit) : ""}
            </DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">日付</dt>
            <dd>{date}</dd>
            <dt className="text-muted-foreground">肥料名</dt>
            <dd className="break-words">{fertilizer.trim()}</dd>
          </dl>
          <DialogFooter className="flex-row gap-3">
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="flex-1"
              onClick={() => setConfirmOpen(false)}
              disabled={pending}
              data-testid="fertilize-confirm-cancel"
            >
              やめる
            </Button>
            <Button
              type="button"
              size="lg"
              className="flex-1"
              onClick={() => void submit()}
              disabled={pending}
              data-testid="fertilize-confirm-submit"
            >
              {pending ? "記録中…" : "記録する"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  );
}

// 対象の株の 1 行: チェック（外す）＋株コード＋量（既定は上の量。変えた行は「個別」の印と色で分かる）。
// 行全体（チェックと株コード）がタップ領域（高さ 48px 以上）。memo して、props が変わった行だけ描き直す
const MatRow = memo(function MatRow({
  id,
  code,
  included,
  override,
  baseAmount,
  unit,
  error,
  onToggle,
  onOverride,
  onReset,
}: {
  id: string;
  code: string;
  included: boolean;
  override: string | undefined;
  baseAmount: string;
  unit: string;
  error: string | null;
  onToggle: (id: string, include: boolean) => void;
  onOverride: (id: string, text: string) => void;
  onReset: (id: string) => void;
}) {
  const overridden = override !== undefined;
  const amountId = `fertilize-mat-amount-${id}`;
  const errorId = `${amountId}-error`;
  // チェック＋株コードの行は共通の部品（mat-select-list.tsx）。量の入力と戻すボタンを右側に足す
  return (
    <MatSelectRow
      testIdPrefix="fertilize"
      id={id}
      code={code}
      included={included}
      onToggle={onToggle}
      highlighted={overridden}
      dataAttributes={{ "data-overridden": overridden ? "true" : undefined }}
      badge={
        overridden &&
        included && (
          <Badge variant="outline" className="h-6 border-primary/40 text-primary" data-testid="fertilize-mat-overridden">
            個別
          </Badge>
        )
      }
      trailing={
        <>
          <Input
            id={amountId}
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            className={cn("w-24 text-right tabular-nums", overridden && "font-semibold")}
            value={overridden ? override : baseAmount}
            disabled={!included}
            onChange={(e) => onOverride(id, e.target.value)}
            aria-label={`株 ${code} の量（${unit}）`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            data-testid="fertilize-mat-amount"
          />
          <span className="w-8 shrink-0 text-sm text-muted-foreground">{unit}</span>
          {overridden && included ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => onReset(id)}
              aria-label={`株 ${code} の量を上の量に戻す`}
              data-testid="fertilize-mat-reset"
            >
              <RotateCcwIcon aria-hidden="true" />
            </Button>
          ) : (
            <span className="size-11 shrink-0" aria-hidden="true" />
          )}
        </>
      }
      below={
        error && (
          <p id={errorId} role="alert" className="text-sm font-medium text-destructive" data-testid="fertilize-mat-error">
            {error}
          </p>
        )
      }
    />
  );
});
