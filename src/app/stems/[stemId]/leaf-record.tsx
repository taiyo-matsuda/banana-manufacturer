"use client";

import { useActionState } from "react";
import { INITIAL_RECORD_STATE } from "@/lib/stems/records";
import { recordLeavesCurrent, recordLeavesNew, recordLeavesRemoved } from "./actions";

const inputClass =
  "h-12 w-full rounded-lg border border-zinc-300 px-3 text-base dark:border-zinc-700 dark:bg-zinc-900";
const bigButtonClass =
  "h-20 flex-1 rounded-xl bg-green-700 text-2xl font-semibold text-white active:bg-green-800 disabled:opacity-60";
const smallButtonClass =
  "h-12 shrink-0 rounded-lg bg-green-700 px-4 text-base font-medium text-white disabled:opacity-60";

// 茎の記録入力（画面 4）。保存ボタンはなく、タップ＝記録（Server Action が insert して refresh する）。
// 観測（leaves_new / leaves_current）は確認なし。イベント（枯葉処理）は confirm を出す。
// 記録を編集・削除する UI は置かない。
export function LeafRecord({ stemId }: { stemId: string }) {
  return (
    <div className="flex flex-col gap-6">
      <LeavesNewForm stemId={stemId} />
      <LeavesRemovedForm stemId={stemId} />
      <LeavesCurrentForm stemId={stemId} />
    </div>
  );
}

function ErrorText({ id, error }: { id: string; error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" data-testid={id} className="text-sm text-red-600 dark:text-red-400">
      {error}
    </p>
  );
}

// 新たに開いた葉: +0 / +1 / +2 の大きなボタン。それ以上は数字入力
function LeavesNewForm({ stemId }: { stemId: string }) {
  const [state, formAction, pending] = useActionState(recordLeavesNew, INITIAL_RECORD_STATE);
  return (
    <form key={state.succeeded} action={formAction} noValidate aria-label="新たに開いた葉" className="flex flex-col gap-3">
      <input type="hidden" name="stemId" value={stemId} />
      <h2 className="text-base font-semibold">新たに開いた葉</h2>
      <div className="flex gap-3">
        {[0, 1, 2].map((n) => (
          <button
            key={n}
            type="submit"
            name="count"
            value={n}
            disabled={pending}
            className={bigButtonClass}
            data-testid={`leaves-new-${n}`}
          >
            +{n}
          </button>
        ))}
      </div>
      <div className="flex items-end gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span>3 枚以上のとき</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            name="countInput"
            className={inputClass}
            data-testid="leaves-new-input"
          />
        </label>
        <button type="submit" disabled={pending} className={smallButtonClass} data-testid="leaves-new-submit">
          {pending ? "記録中…" : "記録"}
        </button>
      </div>
      <ErrorText id="leaves-new-error" error={state.error} />
    </form>
  );
}

// 枯葉処理（イベント）: 枚数を入れて確定。イベント系なので確認ダイアログを出す
function LeavesRemovedForm({ stemId }: { stemId: string }) {
  const [state, formAction, pending] = useActionState(recordLeavesRemoved, INITIAL_RECORD_STATE);
  return (
    <form
      key={state.succeeded}
      action={formAction}
      noValidate
      aria-label="枯葉処理"
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        const count = String(new FormData(e.currentTarget).get("count") ?? "").trim();
        const message = count === "" ? "枯葉処理を記録します。よろしいですか？" : `枯葉処理 ${count} 枚を記録します。よろしいですか？`;
        if (!window.confirm(message)) e.preventDefault();
      }}
    >
      <input type="hidden" name="stemId" value={stemId} />
      <h2 className="text-base font-semibold">枯葉処理</h2>
      <div className="flex items-end gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span>除去した枚数</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            name="count"
            className={inputClass}
            data-testid="leaves-removed-input"
          />
        </label>
        <button type="submit" disabled={pending} className={smallButtonClass} data-testid="leaves-removed-submit">
          {pending ? "記録中…" : "記録"}
        </button>
      </div>
      <ErrorText id="leaves-removed-error" error={state.error} />
    </form>
  );
}

// 現在の葉数（検算用）
function LeavesCurrentForm({ stemId }: { stemId: string }) {
  const [state, formAction, pending] = useActionState(recordLeavesCurrent, INITIAL_RECORD_STATE);
  return (
    <form key={state.succeeded} action={formAction} noValidate aria-label="現在の葉数" className="flex flex-col gap-2">
      <input type="hidden" name="stemId" value={stemId} />
      <h2 className="text-base font-semibold">現在の葉数</h2>
      <div className="flex items-end gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span>今ついている葉の枚数</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            name="count"
            className={inputClass}
            data-testid="leaves-current-input"
          />
        </label>
        <button type="submit" disabled={pending} className={smallButtonClass} data-testid="leaves-current-submit">
          {pending ? "記録中…" : "記録"}
        </button>
      </div>
      <ErrorText id="leaves-current-error" error={state.error} />
    </form>
  );
}
