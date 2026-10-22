"use client";

import { useActionState, useState } from "react";
import type { RegisterStemState } from "@/lib/stems/registration";
import { registerStem } from "./actions";

const inputClass =
  "h-12 w-full rounded-lg border border-zinc-300 px-3 text-base dark:border-zinc-700 dark:bg-zinc-900";

// 株の詳細「茎を登録」フォーム。植え付け日（既定: 株の植え付け日）と初期葉数。
// 検証はサーバー側で行い、理由を画面に出す（noValidate）。成功したらフォームを閉じる。
export function StemForm({
  matId,
  defaultPlantedAt,
  nextGeneration,
}: {
  matId: string;
  defaultPlantedAt: string;
  nextGeneration: number;
}) {
  const initialState: RegisterStemState = {
    error: null,
    errors: {},
    values: { plantedAt: defaultPlantedAt, initialLeafCount: "" },
    succeeded: 0,
  };
  const [state, formAction, pending] = useActionState(registerStem, initialState);
  // 成功した回数が増えたらフォームを閉じる（succeeded が state に乗る）
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const open = openedAt !== null && openedAt === state.succeeded;

  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        {openedAt !== null && (
          <p data-testid="stem-notice" className="text-sm text-green-700 dark:text-green-400">
            茎を登録しました
          </p>
        )}
        <button
          type="button"
          className="h-12 rounded-lg bg-green-700 px-4 text-base font-medium text-white"
          onClick={() => setOpenedAt(state.succeeded)}
          data-testid="stem-add"
        >
          茎を登録
        </button>
      </div>
    );
  }

  const label = nextGeneration === 1 ? "最初の茎（親）を登録" : `第 ${nextGeneration} 世代の茎を登録`;

  return (
    <form
      key={state.succeeded}
      action={formAction}
      className="flex flex-col gap-3 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700"
      noValidate
      aria-label="茎の登録"
      data-testid="stem-form"
    >
      <p className="text-sm font-medium">{label}</p>
      <input type="hidden" name="matId" value={matId} />
      <div className="flex flex-col gap-1 text-sm">
        <label className="flex flex-col gap-1">
          <span>植え付け日</span>
          <input
            type="date"
            name="plantedAt"
            defaultValue={state.values.plantedAt}
            className={inputClass}
            aria-invalid={state.errors.plantedAt ? true : undefined}
            aria-describedby={state.errors.plantedAt ? "stem-error-plantedAt" : undefined}
          />
        </label>
        {state.errors.plantedAt && (
          <span id="stem-error-plantedAt" role="alert" data-testid="stem-error-plantedAt" className="text-red-600 dark:text-red-400">
            {state.errors.plantedAt}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <label className="flex flex-col gap-1">
          <span>初期葉数</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            name="initialLeafCount"
            defaultValue={state.values.initialLeafCount}
            className={inputClass}
            aria-invalid={state.errors.initialLeafCount ? true : undefined}
            aria-describedby={state.errors.initialLeafCount ? "stem-error-initialLeafCount" : undefined}
          />
        </label>
        {!state.errors.initialLeafCount && (
          <span className="text-xs text-zinc-500">植え付け（採用）時点の葉数。累計葉数の数え始めになる</span>
        )}
        {state.errors.initialLeafCount && (
          <span
            id="stem-error-initialLeafCount"
            role="alert"
            data-testid="stem-error-initialLeafCount"
            className="text-red-600 dark:text-red-400"
          >
            {state.errors.initialLeafCount}
          </span>
        )}
      </div>
      {state.error && (
        <p role="alert" data-testid="stem-error" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={pending}
          className="h-12 flex-1 rounded-lg bg-green-700 px-4 text-base font-medium text-white disabled:opacity-60"
          data-testid="stem-submit"
        >
          {pending ? "登録中…" : "登録"}
        </button>
        <button
          type="button"
          disabled={pending}
          className="h-12 rounded-lg border border-zinc-300 px-4 text-base dark:border-zinc-700 disabled:opacity-60"
          onClick={() => setOpenedAt(null)}
        >
          やめる
        </button>
      </div>
    </form>
  );
}
