"use client";

import { startTransition, useActionState, useState } from "react";
import {
  allowedEventTypes,
  DAMAGE_KIND_LABELS,
  DAMAGE_KINDS,
  DAMAGE_SEVERITIES,
  DAMAGE_SEVERITY_LABELS,
  INITIAL_EVENT_RECORD_STATE,
  STEM_EVENT_LABELS,
  type StemEventType,
  todayJst,
} from "@/lib/stemEvents";
import { recordStemEvent } from "./actions";

const inputClass =
  "h-12 w-full rounded-lg border border-zinc-300 px-3 text-base dark:border-zinc-700 dark:bg-zinc-900";
const selectClass =
  "h-12 w-full rounded-lg border border-zinc-300 bg-white px-3 text-base dark:border-zinc-700 dark:bg-zinc-900";
const eventButtonClass =
  "h-16 min-w-[7rem] flex-1 rounded-xl bg-amber-700 px-4 text-lg font-semibold text-white active:bg-amber-800 disabled:opacity-60";

// 茎のイベント（1-8、画面 4「イベント」）。
// 茎の状態に応じてボタンを出し分ける（active → 出蕾・被害 / flowered → 段数・袋掛け・摘蕾・収穫・被害。stemEvents.ts の表）。
// イベント系は誤操作対策として確認を挟む（screens.md 3 章）: ボタン → 入力ダイアログ → 「記録する」で確定。
// 保存は Server Action → RPC record_stem_event（0008）。状態の前提違反などは RPC の日本語メッセージをそのまま出す。
// 記録を編集・削除する UI は置かない（追記のみ）。
// 送信は <form action> に任せず onSubmit で FormData を組んで formAction を呼ぶ（React 19 は <form action> の
// Action 完了後にフォームを自動リセットするため、検証エラーの後に確認日や生葉数が既定値に戻ってしまう。
// 現場ではエラー文言で指摘された項目だけ直して再送信するので、過去日が黙って今日に戻ると誤った bud_emerged_at が残る）。
export function EventRecord({
  stemId,
  status,
  defaultEarliestAt,
}: {
  stemId: string;
  status: string;
  defaultEarliestAt: string | null;
}) {
  const [state, formAction, pending] = useActionState(recordStemEvent, INITIAL_EVENT_RECORD_STATE);
  // 開いたときの succeeded を覚え、成功して増えたら閉じる（stem-form.tsx と同じ仕組み）
  // submitted: このダイアログで送信したか（前に開いたダイアログのエラーを新しいダイアログに持ち越さない）
  const [opened, setOpened] = useState<{ type: StemEventType; at: number; submitted: boolean } | null>(null);
  const open = opened !== null && opened.at === state.succeeded ? opened.type : null;
  const types = allowedEventTypes(status);

  return (
    <section className="flex flex-col gap-3" aria-label="イベント" data-testid="event-section">
      <h2 className="text-base font-semibold">イベント</h2>
      {state.lastType && open === null && (
        <p data-testid="event-notice" className="text-sm text-green-700 dark:text-green-400">
          {STEM_EVENT_LABELS[state.lastType]}を記録しました
        </p>
      )}
      <div className="flex flex-wrap gap-3" data-testid="event-buttons">
        {types.map((t) => (
          <button
            key={t}
            type="button"
            className={eventButtonClass}
            disabled={pending}
            onClick={() => setOpened({ type: t, at: state.succeeded, submitted: false })}
            data-testid={`event-button-${t}`}
          >
            {STEM_EVENT_LABELS[t]}
          </button>
        ))}
      </div>
      {open !== null && (
        <EventDialog
          key={`${open}:${state.succeeded}`}
          stemId={stemId}
          type={open}
          defaultEarliestAt={defaultEarliestAt}
          error={opened?.submitted ? state.error : null}
          pending={pending}
          formAction={formAction}
          onSubmit={() => setOpened((o) => (o ? { ...o, submitted: true } : o))}
          onCancel={() => setOpened(null)}
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
  formAction,
  onSubmit,
  onCancel,
}: {
  stemId: string;
  type: StemEventType;
  defaultEarliestAt: string | null;
  error: string | null;
  pending: boolean;
  formAction: (formData: FormData) => void;
  onSubmit: () => void;
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
          // 自動リセットを避ける: 自前で FormData を組み、transition の中で Action を呼ぶ（エラー後も入力値が残る）
          e.preventDefault();
          if (pending) return;
          const formData = new FormData(e.currentTarget);
          onSubmit();
          startTransition(() => formAction(formData));
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
