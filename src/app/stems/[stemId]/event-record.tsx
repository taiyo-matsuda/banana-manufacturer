"use client";

import { useState } from "react";
import { FormField } from "@/components/app/form-field";
import { NumberField } from "@/components/app/number-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { enqueueStemEvent } from "@/lib/offline/enqueue";
import { stemStatusLabel } from "@/lib/stems/status";
import {
  allowedEventTypes,
  canRecordEvent,
  DAMAGE_KIND_LABELS,
  DAMAGE_KINDS,
  DAMAGE_SEVERITIES,
  DAMAGE_SEVERITY_LABELS,
  occurredAtFromDate,
  parseEventInput,
  STEM_EVENT_LABELS,
  type StemEventType,
  stemEventLabel,
  todayJst,
} from "@/lib/stemEvents";

// 茎のイベント（1-8、画面 4「イベント」）。
// 茎の状態（未送信のイベントを反映した見かけの状態）に応じてボタンを出し分ける（stemEvents.ts の表）。
// イベント系は誤操作対策として確認を挟む（screens.md 3 章）: ボタン → 入力ダイアログ → 「記録する」で確定。
// 保存は端末の outbox に積む（1-9）。同期ワーカーが RPC record_stem_event（0009、id で冪等）を呼び、
// 状態の前提違反などサーバーで拒否されたものは「要確認」としてヘッダの同期状態から辿れる。
// 出蕾の累計葉数は、画面が持つ観測 + 未送信分から計算した値（props）を payload に入れる。
// 記録を編集・削除する UI は置かない（追記のみ）。
// 検証エラーの後も入力値が残るよう、<form action> ではなく onSubmit で FormData を組む。
export function EventRecord({
  stemId,
  userId,
  status,
  cumulativeLeaves,
  defaultEarliestAt,
}: {
  stemId: string;
  userId: string;
  status: string;
  cumulativeLeaves: number;
  defaultEarliestAt: string | null;
}) {
  const [opened, setOpened] = useState<StemEventType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [lastType, setLastType] = useState<StemEventType | null>(null);
  const [succeeded, setSucceeded] = useState(0);
  const types = allowedEventTypes(status);

  const submit = async (formData: FormData) => {
    if (pending) return;
    const text = (name: string) => {
      const v = formData.get(name);
      return v === null ? undefined : String(v);
    };
    const parsed = parseEventInput({
      type: text("type") ?? "",
      date: text("date") ?? "",
      earliestAt: text("earliestAt"),
      leavesCurrent: text("leavesCurrent"),
      girthCm: text("girthCm"),
      hands: text("hands"),
      weightKg: text("weightKg"),
      kind: text("kind"),
      severity: text("severity"),
    });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const { type, date, payload } = parsed.value;
    if (!canRecordEvent(status, type)) {
      setError(`${stemEventLabel(type)}はこの茎（${stemStatusLabel(status)}）には記録できません`);
      return;
    }
    if (type === "bud_emerged") payload.cumulative_leaves = cumulativeLeaves;

    setPending(true);
    try {
      await enqueueStemEvent({ stemId, userId, type, occurredAt: occurredAtFromDate(date), payload });
      setError(null);
      setLastType(type);
      setSucceeded((n) => n + 1);
      setOpened(null);
    } catch (err) {
      console.error("event enqueue failed", err);
      setError("端末に保存できませんでした。時間をおいて再度お試しください");
    } finally {
      setPending(false);
    }
  };

  return (
    <Card aria-label="イベント" data-testid="event-section">
      <CardHeader>
        <CardTitle>イベント</CardTitle>
        <CardDescription>出蕾・袋掛け・収穫など。確認してから記録します</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {lastType && opened === null && (
          <Alert variant="success" data-testid="event-notice">
            <AlertDescription>{STEM_EVENT_LABELS[lastType]}を記録しました</AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-2 gap-3" data-testid="event-buttons">
          {types.map((t) => (
            <Button
              key={t}
              type="button"
              variant="secondary"
              size="lg"
              className="h-16 text-lg"
              disabled={pending}
              onClick={() => {
                setError(null);
                setOpened(t);
              }}
              data-testid={`event-button-${t}`}
            >
              {STEM_EVENT_LABELS[t]}
            </Button>
          ))}
        </div>
        {opened !== null && (
          <EventDialog
            key={`${opened}:${succeeded}`}
            stemId={stemId}
            type={opened}
            defaultEarliestAt={defaultEarliestAt}
            error={error}
            pending={pending}
            onSubmit={submit}
            onCancel={() => {
              if (!pending) setOpened(null);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function EventDialog({
  stemId,
  type,
  defaultEarliestAt,
  error,
  pending,
  onSubmit,
  onCancel,
}: {
  stemId: string;
  type: StemEventType;
  defaultEarliestAt: string | null;
  error: string | null;
  pending: boolean;
  onSubmit: (formData: FormData) => Promise<void>;
  onCancel: () => void;
}) {
  const label = STEM_EVENT_LABELS[type];
  const today = todayJst();
  const description =
    type === "bud_emerged"
      ? "累計葉数はこの時点の値が自動で記録されます"
      : type === "harvested"
        ? "収穫を記録すると、この茎は収穫済みになり記録入力が閉じます"
        : type === "damage"
          ? "程度を「喪失」にすると茎は終了します"
          : `${label}を記録します。よろしいですか？`;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        // 開いた瞬間に日付入力へフォーカスが入ると、iPhone では日付ピッカーが勝手に開くので、自動フォーカスしない
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="max-h-[90vh] overflow-y-auto"
        data-testid="event-dialog"
        data-type={type}
      >
        <form
          onSubmit={(e) => {
            // 自前で FormData を組んで渡す（エラー後も入力値が残る。フォームは自動でリセットされない）
            e.preventDefault();
            if (pending) return;
            void onSubmit(new FormData(e.currentTarget));
          }}
          noValidate
          className="flex flex-col gap-4"
        >
          <Input type="hidden" name="stemId" value={stemId} />
          <Input type="hidden" name="type" value={type} />
          <DialogHeader>
            <DialogTitle>{label}を記録</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <FormField id="event-date" label={type === "bud_emerged" ? "確認日" : "日付"}>
            <Input id="event-date" type="date" name="date" defaultValue={today} required data-testid="event-date" />
          </FormField>

          {type === "bud_emerged" && (
            <>
              <FormField id="event-earliest-at" label="前回訪問日" hint="蕾がまだ無かった日。空でもよい">
                <Input
                  id="event-earliest-at"
                  type="date"
                  name="earliestAt"
                  defaultValue={defaultEarliestAt ?? ""}
                  data-testid="event-earliest-at"
                />
              </FormField>
              <NumberField id="event-leaves-current" label="生葉数" unit="枚" min={0} step={1} name="leavesCurrent" data-testid="event-leaves-current" />
              <NumberField
                id="event-girth-cm"
                label="偽茎周囲長（地上 1m）"
                unit="cm"
                inputMode="decimal"
                min={0}
                step={0.1}
                name="girthCm"
                data-testid="event-girth-cm"
              />
            </>
          )}

          {type === "hands_counted" && (
            <NumberField
              id="event-hands"
              label="段数"
              unit="段"
              hint="苞が開ききった時点"
              min={1}
              step={1}
              name="hands"
              data-testid="event-hands"
            />
          )}

          {type === "harvested" && (
            <NumberField
              id="event-weight-kg"
              label="果房重量"
              unit="kg"
              hint="小数 1 桁"
              inputMode="decimal"
              min={0}
              step={0.1}
              name="weightKg"
              data-testid="event-weight-kg"
            />
          )}

          {type === "damage" && (
            <>
              <FormField id="event-kind" label="種類">
                <NativeSelect id="event-kind" name="kind" defaultValue="" data-testid="event-kind">
                  <NativeSelectOption value="">選んでください</NativeSelectOption>
                  {DAMAGE_KINDS.map((k) => (
                    <NativeSelectOption key={k} value={k}>
                      {DAMAGE_KIND_LABELS[k]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField id="event-severity" label="程度">
                <NativeSelect id="event-severity" name="severity" defaultValue="" data-testid="event-severity">
                  <NativeSelectOption value="">選んでください</NativeSelectOption>
                  {DAMAGE_SEVERITIES.map((s) => (
                    <NativeSelectOption key={s} value={s}>
                      {DAMAGE_SEVERITY_LABELS[s]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </FormField>
            </>
          )}

          {error && (
            <Alert variant="destructive" data-testid="event-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter className="flex-row gap-3">
            <Button type="button" variant="outline" size="lg" className="flex-1" onClick={onCancel} disabled={pending} data-testid="event-cancel">
              やめる
            </Button>
            <Button type="submit" size="lg" className="flex-1" disabled={pending} data-testid="event-submit">
              {pending ? "記録中…" : "記録する"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
