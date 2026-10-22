"use client";

import { useActionState } from "react";
import { type CreateFieldState, EMPTY_FIELD_INPUT } from "@/lib/fields/validation";
import { createField } from "./actions";

const initialState: CreateFieldState = {
  error: null,
  errors: {},
  values: EMPTY_FIELD_INPUT,
  succeeded: 0,
};

const inputClass =
  "h-12 rounded-lg border border-zinc-300 px-3 text-base dark:border-zinc-700 dark:bg-zinc-900";

// 圃場の新規登録フォーム。検証はサーバー側で行い、理由を画面に出す（noValidate）。
export function FieldForm() {
  const [state, formAction, pending] = useActionState(createField, initialState);

  return (
    // 成功したらフォームを空に戻す（key を変えて再マウント）
    <form
      key={state.succeeded}
      action={formAction}
      className="flex flex-col gap-4"
      noValidate
      aria-label="圃場の新規登録"
    >
      <Field label="名前" error={state.errors.name} errorId="field-error-name">
        <input
          type="text"
          name="name"
          defaultValue={state.values.name}
          autoComplete="off"
          className={inputClass}
          aria-invalid={state.errors.name ? true : undefined}
          aria-describedby={state.errors.name ? "field-error-name" : undefined}
        />
      </Field>
      <Field
        label="圃場記号"
        hint="英数字 1〜4 文字（株コードの先頭に使う。例: A）"
        error={state.errors.code}
        errorId="field-error-code"
      >
        <input
          type="text"
          name="code"
          defaultValue={state.values.code}
          autoComplete="off"
          autoCapitalize="characters"
          maxLength={4}
          className={inputClass}
          aria-invalid={state.errors.code ? true : undefined}
          aria-describedby={state.errors.code ? "field-error-code" : undefined}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="緯度" error={state.errors.lat} errorId="field-error-lat">
          <input
            type="text"
            inputMode="decimal"
            name="lat"
            placeholder="26.5"
            defaultValue={state.values.lat}
            className={inputClass}
            aria-invalid={state.errors.lat ? true : undefined}
            aria-describedby={state.errors.lat ? "field-error-lat" : undefined}
          />
        </Field>
        <Field label="経度" error={state.errors.lng} errorId="field-error-lng">
          <input
            type="text"
            inputMode="decimal"
            name="lng"
            placeholder="127.9"
            defaultValue={state.values.lng}
            className={inputClass}
            aria-invalid={state.errors.lng ? true : undefined}
            aria-describedby={state.errors.lng ? "field-error-lng" : undefined}
          />
        </Field>
      </div>
      {state.error && (
        <p
          role="alert"
          data-testid="field-error"
          className="text-sm text-red-600 dark:text-red-400"
        >
          {state.error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="h-12 rounded-lg bg-green-700 text-base font-medium text-white disabled:opacity-60"
      >
        {pending ? "登録中…" : "登録"}
      </button>
    </form>
  );
}

function Field({
  label,
  hint,
  error,
  errorId,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  errorId: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      <label className="flex flex-col gap-1">
        <span>{label}</span>
        {children}
      </label>
      {hint && !error && <span className="text-xs text-zinc-500">{hint}</span>}
      {error && (
        <span
          id={errorId}
          role="alert"
          data-testid={errorId}
          className="text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </span>
      )}
    </div>
  );
}
