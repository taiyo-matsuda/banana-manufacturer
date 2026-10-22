"use client";

import { useState } from "react";
import { enqueueLeavesRemoved, enqueueObservation } from "@/lib/offline/enqueue";
import { parseLeavesCurrent, parseLeavesNew, parseLeavesRemoved } from "@/lib/stems/records";

const inputClass =
  "h-12 w-full rounded-lg border border-zinc-300 px-3 text-base dark:border-zinc-700 dark:bg-zinc-900";
const bigButtonClass =
  "h-20 flex-1 rounded-xl bg-green-700 text-2xl font-semibold text-white active:bg-green-800 disabled:opacity-60";
const smallButtonClass =
  "h-12 shrink-0 rounded-lg bg-green-700 px-4 text-base font-medium text-white disabled:opacity-60";

// 茎の記録入力（画面 4）。保存ボタンはなく、タップ＝記録。
// 記録は端末の outbox に積む（1-9。オンラインでも同じ経路）。画面は outbox の購読で即座に反映され、同期後にサーバーの最新に揃う。
// 観測（leaves_new / leaves_current）は確認なし。イベント（枯葉処理）は confirm を出す。
// 記録を編集・削除する UI は置かない。
// Server Action を使わないので、フォーム送信後の入力のクリアは自前で行う（React 19 の自動リセットには頼らない）。
export function LeafRecord({ stemId, userId }: { stemId: string; userId: string }) {
  return (
    <div className="flex flex-col gap-6">
      <LeavesNewForm stemId={stemId} userId={userId} />
      <LeavesRemovedForm stemId={stemId} userId={userId} />
      <LeavesCurrentForm stemId={stemId} userId={userId} />
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

const SAVE_FAILED = "端末に保存できませんでした。時間をおいて再度お試しください";

// 送信中フラグとエラー。run は端末への保存（outbox）なので圏外でも成功する
function useRecord() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const run = async (work: () => Promise<void>) => {
    if (pending) return false;
    setPending(true);
    try {
      await work();
      setError(null);
      return true;
    } catch (err) {
      console.error("record failed", err);
      setError(SAVE_FAILED);
      return false;
    } finally {
      setPending(false);
    }
  };
  return { error, setError, pending, run };
}

// 新たに開いた葉: +0 / +1 / +2 の大きなボタン。それ以上は数字入力
function LeavesNewForm({ stemId, userId }: { stemId: string; userId: string }) {
  const { error, setError, pending, run } = useRecord();
  const [input, setInput] = useState("");

  const record = async (raw: string) => {
    const parsed = parseLeavesNew(raw);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const ok = await run(() => enqueueObservation({ stemId, type: "leaves_new", value: parsed.value, userId }).then(() => undefined));
    if (ok) setInput("");
  };

  return (
    <form
      noValidate
      aria-label="新たに開いた葉"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void record(input);
      }}
    >
      <h2 className="text-base font-semibold">新たに開いた葉</h2>
      <div className="flex gap-3">
        {[0, 1, 2].map((n) => (
          <button
            key={n}
            type="button"
            disabled={pending}
            className={bigButtonClass}
            data-testid={`leaves-new-${n}`}
            onClick={() => void record(String(n))}
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
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className={inputClass}
            data-testid="leaves-new-input"
          />
        </label>
        <button type="submit" disabled={pending} className={smallButtonClass} data-testid="leaves-new-submit">
          {pending ? "記録中…" : "記録"}
        </button>
      </div>
      <ErrorText id="leaves-new-error" error={error} />
    </form>
  );
}

// 枯葉処理（イベント）: 枚数を入れて確定。イベント系なので確認ダイアログを出す
function LeavesRemovedForm({ stemId, userId }: { stemId: string; userId: string }) {
  const { error, setError, pending, run } = useRecord();
  const [input, setInput] = useState("");

  return (
    <form
      noValidate
      aria-label="枯葉処理"
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const count = input.trim();
        const message = count === "" ? "枯葉処理を記録します。よろしいですか？" : `枯葉処理 ${count} 枚を記録します。よろしいですか？`;
        if (!window.confirm(message)) return;
        const parsed = parseLeavesRemoved(count);
        if (!parsed.ok) {
          setError(parsed.error);
          return;
        }
        void run(() => enqueueLeavesRemoved({ stemId, count: parsed.value, userId }).then(() => undefined)).then((ok) => {
          if (ok) setInput("");
        });
      }}
    >
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
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className={inputClass}
            data-testid="leaves-removed-input"
          />
        </label>
        <button type="submit" disabled={pending} className={smallButtonClass} data-testid="leaves-removed-submit">
          {pending ? "記録中…" : "記録"}
        </button>
      </div>
      <ErrorText id="leaves-removed-error" error={error} />
    </form>
  );
}

// 現在の葉数（検算用）
function LeavesCurrentForm({ stemId, userId }: { stemId: string; userId: string }) {
  const { error, setError, pending, run } = useRecord();
  const [input, setInput] = useState("");

  return (
    <form
      noValidate
      aria-label="現在の葉数"
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = parseLeavesCurrent(input);
        if (!parsed.ok) {
          setError(parsed.error);
          return;
        }
        void run(() => enqueueObservation({ stemId, type: "leaves_current", value: parsed.value, userId }).then(() => undefined)).then((ok) => {
          if (ok) setInput("");
        });
      }}
    >
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
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className={inputClass}
            data-testid="leaves-current-input"
          />
        </label>
        <button type="submit" disabled={pending} className={smallButtonClass} data-testid="leaves-current-submit">
          {pending ? "記録中…" : "記録"}
        </button>
      </div>
      <ErrorText id="leaves-current-error" error={error} />
    </form>
  );
}
