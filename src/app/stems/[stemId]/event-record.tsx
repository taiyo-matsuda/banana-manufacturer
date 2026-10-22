"use client";

import { useState } from "react";
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

const inputClass =
  "h-12 w-full rounded-lg border border-zinc-300 px-3 text-base dark:border-zinc-700 dark:bg-zinc-900";
const selectClass =
  "h-12 w-full rounded-lg border border-zinc-300 bg-white px-3 text-base dark:border-zinc-700 dark:bg-zinc-900";
const eventButtonClass =
  "h-16 min-w-[7rem] flex-1 rounded-xl bg-amber-700 px-4 text-lg font-semibold text-white active:bg-amber-800 disabled:opacity-60";

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
    <section className="flex flex-col gap-3" aria-label="イベント" data-testid="event-section">
      <h2 className="text-base font-semibold">イベント</h2>
      {lastType && opened === null && (
        <p data-testid="event-notice" className="text-sm text-green-700 dark:text-green-400">
          {STEM_EVENT_LABELS[lastType]}を記録しました
        </p>
      )}
      <div className="flex flex-wrap gap-3" data-testid="event-buttons">
        {types.map((t) => (
          <button
            key={t}
            type="button"
            className={eventButtonClass}
            disabled={pending}
            onClick={() => {
              setError(null);
              setOpened(t);
            }}
            data-testid={`event-button-${t}`}
          >
            {STEM_EVENT_LABELS[t]}
          </button>
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
    </section>
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
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${label}を記録`}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
      data-testid="event-dialog"
      data-type={type}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !pending) onCancel();
      }}
    >
      <form
        onSubmit={(e) => {
          // 自前で FormData を組んで渡す（エラー後も入力値が残る。フォームは自動でリセットされない）
          e.preventDefault();
          if (pending) return;
          void onSubmit(new FormData(e.currentTarget));
        }}
        noValidate
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-t-2xl bg-white p-4 dark:bg-zinc-950 sm:rounded-2xl"
      >
        <input type="hidden" name="stemId" value={stemId} />
        <input type="hidden" name="type" value={type} />
        <h3 className="text-lg font-semibold">{label}を記録</h3>

        <label className="flex flex-col gap-1 text-sm">
          <span>{type === "bud_emerged" ? "確認日" : "日付"}</span>
          <input type="date" name="date" defaultValue={today} required className={inputClass} data-testid="event-date" />
        </label>

        {type === "bud_emerged" && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span>前回訪問日（蕾がまだ無かった日。空でもよい）</span>
              <input
                type="date"
                name="earliestAt"
                defaultValue={defaultEarliestAt ?? ""}
                className={inputClass}
                data-testid="event-earliest-at"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>生葉数（枚）</span>
              <input type="number" inputMode="numeric" min={0} step={1} name="leavesCurrent" className={inputClass} data-testid="event-leaves-current" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>偽茎周囲長（cm、地上 1m）</span>
              <input type="number" inputMode="decimal" min={0} step={0.1} name="girthCm" className={inputClass} data-testid="event-girth-cm" />
            </label>
            <p className="text-xs text-zinc-500">累計葉数はこの時点の値が自動で記録されます</p>
          </>
        )}

        {type === "hands_counted" && (
          <label className="flex flex-col gap-1 text-sm">
            <span>段数（苞が開ききった時点）</span>
            <input type="number" inputMode="numeric" min={1} step={1} name="hands" className={inputClass} data-testid="event-hands" />
          </label>
        )}

        {type === "harvested" && (
          <label className="flex flex-col gap-1 text-sm">
            <span>果房重量（kg、小数 1 桁）</span>
            <input type="number" inputMode="decimal" min={0} step={0.1} name="weightKg" className={inputClass} data-testid="event-weight-kg" />
          </label>
        )}

        {type === "damage" && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              <span>種類</span>
              <select name="kind" defaultValue="" className={selectClass} data-testid="event-kind">
                <option value="">選んでください</option>
                {DAMAGE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {DAMAGE_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>程度（喪失にすると茎は終了します）</span>
              <select name="severity" defaultValue="" className={selectClass} data-testid="event-severity">
                <option value="">選んでください</option>
                {DAMAGE_SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {DAMAGE_SEVERITY_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {(type === "bagged" || type === "debudded") && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{label}を記録します。よろしいですか？</p>
        )}
        {type === "harvested" && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">収穫を記録すると、この茎は収穫済みになり記録入力が閉じます</p>
        )}

        {error && (
          <p role="alert" data-testid="event-error" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="h-14 flex-1 rounded-xl border border-zinc-300 text-base font-medium dark:border-zinc-700"
            data-testid="event-cancel"
          >
            やめる
          </button>
          <button
            type="submit"
            disabled={pending}
            className="h-14 flex-1 rounded-xl bg-amber-700 text-base font-semibold text-white active:bg-amber-800 disabled:opacity-60"
            data-testid="event-submit"
          >
            {pending ? "記録中…" : "記録する"}
          </button>
        </div>
      </form>
    </div>
  );
}
