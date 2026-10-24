"use client";

import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { FormField } from "@/components/app/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type CreateFieldState, EMPTY_FIELD_INPUT } from "@/lib/fields/validation";
import { createField } from "./actions";

const initialState: CreateFieldState = {
  error: null,
  errors: {},
  values: EMPTY_FIELD_INPUT,
  succeeded: 0,
};

// 圃場の新規登録フォーム（/fields/new）。検証はサーバー側で行い、理由を画面に出す（noValidate）。
// 成功すると state.succeeded が増える（Server Action の挙動は 1-2 のまま）ので、そのときだけ一覧（/fields）へ戻る。
// （useEffect で見張ると、クライアント遷移で画面が保持されたまま再表示されたときにもう一度戻ってしまうので、Action の結果で判断する）
export function FieldForm() {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(async (prev: CreateFieldState, formData: FormData) => {
    const next = await createField(prev, formData);
    if (next.succeeded > prev.succeeded) router.push("/fields");
    return next;
  }, initialState);

  return (
    <form
      key={state.succeeded}
      action={formAction}
      className="flex flex-col gap-4"
      noValidate
      aria-label="圃場の新規登録"
      data-testid="field-form"
    >
      <FormField id="field-name" label="名前" error={state.errors.name} errorId="field-error-name">
        <Input
          id="field-name"
          type="text"
          name="name"
          defaultValue={state.values.name}
          autoComplete="off"
          aria-invalid={state.errors.name ? true : undefined}
          aria-describedby={state.errors.name ? "field-error-name" : undefined}
        />
      </FormField>
      <FormField
        id="field-code"
        label="圃場記号"
        hint="英数字 1〜4 文字（株コードの先頭に使う。例: A）"
        error={state.errors.code}
        errorId="field-error-code"
      >
        <Input
          id="field-code"
          type="text"
          name="code"
          defaultValue={state.values.code}
          autoComplete="off"
          autoCapitalize="characters"
          maxLength={4}
          className="max-w-32 font-mono"
          aria-invalid={state.errors.code ? true : undefined}
          aria-describedby={state.errors.code ? "field-error-code" : undefined}
        />
      </FormField>
      <div className="grid grid-cols-2 gap-4">
        <FormField id="field-lat" label="緯度" hint="例: 26.5" error={state.errors.lat} errorId="field-error-lat">
          <Input
            id="field-lat"
            type="text"
            inputMode="decimal"
            name="lat"
            defaultValue={state.values.lat}
            aria-invalid={state.errors.lat ? true : undefined}
            aria-describedby={state.errors.lat ? "field-error-lat" : undefined}
          />
        </FormField>
        <FormField id="field-lng" label="経度" hint="例: 127.9" error={state.errors.lng} errorId="field-error-lng">
          <Input
            id="field-lng"
            type="text"
            inputMode="decimal"
            name="lng"
            defaultValue={state.values.lng}
            aria-invalid={state.errors.lng ? true : undefined}
            aria-describedby={state.errors.lng ? "field-error-lng" : undefined}
          />
        </FormField>
      </div>
      {state.error && (
        <Alert variant="destructive" data-testid="field-error">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "登録中…" : "登録"}
      </Button>
    </form>
  );
}
