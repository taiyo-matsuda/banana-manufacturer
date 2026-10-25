"use client";

import { useState } from "react";
import { cn } from "cn";
import { FormField } from "@/components/app/form-field";
import { RecordButton } from "@/components/app/record-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { MatStemRow } from "@/lib/offline/overlay";
import { enqueueSuckerEmerged } from "@/lib/offline/enqueue";
import { occurredAtFromDate, todayJst } from "@/lib/stemEvents";
import { generationLabel, stemStatusLabel } from "@/lib/stems/status";
import {
  buildSuckerPayload,
  cumulativeLeavesAsOf,
  defaultSuckerEarliestAt,
  defaultSuckerParent,
  NO_SUCKER_PARENT_MESSAGE,
  parseSuckerInput,
  SUCKER_DIRECTION_GRID,
  SUCKER_DIRECTION_LABELS,
  SUCKER_TYPE_DESCRIPTIONS,
  SUCKER_TYPE_LABELS,
  SUCKER_TYPES,
  suckerParentCandidates,
} from "@/lib/suckers";

// 「吸芽が出た」（2-1、要件 5.3）。株の詳細の茎一覧の下に置く。
// 入力: 親茎（既定: 栽培中の茎のうち最も世代の若い茎。選び直せる）、方向（8 方位を 3×3 に。中央は空き）、
// 種類（剣葉 / 水吸芽）、確認日（既定 今日）、前回訪問日（既定: 確認日より前の、この株の最新の観測日。空でもよい）。
// 親の累計葉数は、画面が持つ観測 + 未送信分から確認日までの値を計算して payload に入れる。
// 保存は端末の outbox に積む（1-9）。同期ワーカーが RPC record_sucker_emerged（0010、id で冪等）を呼ぶ。
// 栽培中の茎が無ければボタンを出さず理由を表示する。吸芽は最大 3 本の制約に数えない。
export function SuckerRecord({ stems, observedAts }: { stems: MatStemRow[]; observedAts: string[] }) {
  const candidates = suckerParentCandidates(stems);
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(0); // 開くたびにフォームを初期化する key
  const [notice, setNotice] = useState(false);

  if (candidates.length === 0) {
    return (
      <p className="text-muted-foreground" data-testid="sucker-blocked">
        {NO_SUCKER_PARENT_MESSAGE}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="sucker-section">
      {notice && !open && (
        <Alert variant="success" data-testid="sucker-notice">
          <AlertDescription>吸芽を記録しました</AlertDescription>
        </Alert>
      )}
      <RecordButton
        type="button"
        variant="secondary"
        onClick={() => {
          setOpened((n) => n + 1);
          setNotice(false);
          setOpen(true);
        }}
        data-testid="sucker-open"
      >
        吸芽が出た
      </RecordButton>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[90vh] overflow-y-auto"
          // 開いた瞬間に日付入力へフォーカスが入ると iPhone で日付ピッカーが開くので、自動フォーカスしない
          onOpenAutoFocus={(e) => e.preventDefault()}
          data-testid="sucker-sheet"
        >
          <SuckerForm
            key={opened}
            stems={stems}
            candidates={candidates}
            observedAts={observedAts}
            onDone={() => {
              setOpen(false);
              setNotice(true);
            }}
            onCancel={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function SuckerForm({
  stems,
  candidates,
  observedAts,
  onDone,
  onCancel,
}: {
  stems: MatStemRow[];
  candidates: MatStemRow[];
  observedAts: string[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [parentStemId, setParentStemId] = useState(() => defaultSuckerParent(candidates)?.id ?? "");
  const [direction, setDirection] = useState("");
  const [suckerType, setSuckerType] = useState("");
  const [date, setDate] = useState(() => todayJst());
  // 前回訪問日: 手で変えるまでは確認日に合わせて既定値（確認日より前の最新の観測日）を選び直す
  const [earliestEdited, setEarliestEdited] = useState<string | null>(null);
  const earliestAt = earliestEdited ?? defaultSuckerEarliestAt(observedAts, date) ?? "";
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (pending) return;
    const parsed = parseSuckerInput({ parentStemId, direction, suckerType, date, earliestAt }, candidates);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const v = parsed.value;
    const parent = stems.find((s) => s.id === v.parentStemId);
    if (!parent) {
      setError("親茎を選んでください");
      return;
    }
    const parentCumulativeLeaves = cumulativeLeavesAsOf(parent.initial_leaf_count, parent.observations, v.date);
    setPending(true);
    try {
      await enqueueSuckerEmerged({
        parentStemId: parent.id,
        occurredAt: occurredAtFromDate(v.date),
        buildPayload: (suckerStemId) =>
          buildSuckerPayload({
            suckerStemId,
            parentCumulativeLeaves,
            earliestAt: v.earliestAt,
            direction: v.direction,
            suckerType: v.suckerType,
          }),
      });
      setError(null);
      onDone();
    } catch (err) {
      console.error("sucker enqueue failed", err);
      setError("端末に保存できませんでした。時間をおいて再度お試しください");
    } finally {
      setPending(false);
    }
  };

  const stemName = (s: MatStemRow) => `${generationLabel(s.generation)}（第 ${s.generation} 世代・${stemStatusLabel(s.status)}）`;

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
        <SheetTitle className="text-lg">吸芽を記録</SheetTitle>
        <SheetDescription>親茎の累計葉数はこの時点の値が自動で記録されます</SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-4 px-4">
        {candidates.length > 1 ? (
          <FormField id="sucker-parent" label="親茎">
            <NativeSelect
              id="sucker-parent"
              value={parentStemId}
              onChange={(e) => setParentStemId(e.target.value)}
              data-testid="sucker-parent"
            >
              {candidates.map((s) => (
                <NativeSelectOption key={s.id} value={s.id}>
                  {stemName(s)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormField>
        ) : (
          <div className="flex flex-col gap-2">
            <span className="text-base font-medium">親茎</span>
            <span data-testid="sucker-parent-fixed">{stemName(candidates[0])}</span>
          </div>
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-base font-medium">方向（上が北）</legend>
          <div className="mx-auto grid w-full max-w-72 grid-cols-3 gap-2" data-testid="sucker-directions">
            {SUCKER_DIRECTION_GRID.map((d, i) =>
              d === null ? (
                <span key={`center-${i}`} className="flex h-14 items-center justify-center text-sm text-muted-foreground" aria-hidden="true">
                  株
                </span>
              ) : (
                <Button
                  key={d}
                  type="button"
                  variant={direction === d ? "default" : "outline"}
                  className="h-14 w-full"
                  aria-pressed={direction === d}
                  onClick={() => setDirection(d)}
                  data-testid={`sucker-direction-${d}`}
                >
                  {SUCKER_DIRECTION_LABELS[d]}
                </Button>
              ),
            )}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-base font-medium">種類</legend>
          <div className="grid grid-cols-2 gap-2">
            {SUCKER_TYPES.map((t) => (
              <Button
                key={t}
                type="button"
                variant={suckerType === t ? "default" : "outline"}
                className="h-auto min-h-16 w-full flex-col gap-1 py-2 whitespace-normal"
                aria-pressed={suckerType === t}
                onClick={() => setSuckerType(t)}
                data-testid={`sucker-type-${t}`}
              >
                <span className="text-lg">{SUCKER_TYPE_LABELS[t]}</span>
                <span className={cn("text-xs", suckerType === t ? "text-primary-foreground" : "text-muted-foreground")}>
                  {SUCKER_TYPE_DESCRIPTIONS[t]}
                </span>
              </Button>
            ))}
          </div>
        </fieldset>

        <FormField id="sucker-date" label="確認日">
          <Input id="sucker-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid="sucker-date" />
        </FormField>
        <FormField id="sucker-earliest-at" label="前回訪問日" hint="吸芽がまだ無かった日。空でもよい">
          <Input
            id="sucker-earliest-at"
            type="date"
            value={earliestAt}
            onChange={(e) => setEarliestEdited(e.target.value)}
            data-testid="sucker-earliest-at"
          />
        </FormField>

        {error && (
          <Alert variant="destructive" data-testid="sucker-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>

      <SheetFooter className="flex-row gap-3 pt-0">
        <Button type="button" variant="outline" size="lg" className="flex-1" onClick={onCancel} disabled={pending} data-testid="sucker-cancel">
          やめる
        </Button>
        <Button type="submit" size="lg" className="flex-1" disabled={pending} data-testid="sucker-submit">
          {pending ? "記録中…" : "記録する"}
        </Button>
      </SheetFooter>
    </form>
  );
}
