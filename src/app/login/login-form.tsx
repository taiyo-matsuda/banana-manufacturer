"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

const initialState: LoginState = { error: null, email: "" };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <label className="flex flex-col gap-1 text-sm">
        <span>メールアドレス</span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          required
          defaultValue={state.email}
          className="h-12 rounded-lg border border-zinc-300 px-3 text-base dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span>パスワード</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          className="h-12 rounded-lg border border-zinc-300 px-3 text-base dark:border-zinc-700 dark:bg-zinc-900"
        />
      </label>
      {state.error && (
        <p
          role="alert"
          data-testid="login-error"
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
        {pending ? "ログイン中…" : "ログイン"}
      </button>
    </form>
  );
}
