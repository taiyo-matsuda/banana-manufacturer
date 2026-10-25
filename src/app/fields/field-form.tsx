"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { FormField } from "@/components/app/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  type CreateFieldState,
  EMPTY_FIELD_INPUT,
  FIELD_CODE_CHANGE_NOTICE,
  type FieldInput,
  isFieldCodeChanged,
} from "@/lib/fields/validation";
import { createField, updateField } from "./actions";

export type FieldFormProps =
  | { mode: "create" }
  | {
      mode: "edit";
      fieldId: string;
      // いま保存されている値（フォームの初期値）
      initial: FieldInput;
    };

// 圃場の登録（/fields/new）と編集（/fields/[fieldId]/edit、UX-2）で共通のフォーム。
// 検証はサーバー側で行い、理由を画面に出す（noValidate）。
// 失敗時は Action が送った値を state.values に入れて返し、入力欄の defaultValue にする。React 19 は Action の後に
// フォームをリセットする（defaultValue に戻す）ので、defaultValue を送った値にしておけば入力は消えない。
// 成功すると state.succeeded が増えるので、そのときだけ遷移する（登録は一覧へ、編集は圃場の詳細へ）。
// （useEffect で見張ると、クライアント遷移で画面が保持されたまま再表示されたときにもう一度遷移してしまうので、Action の結果で判断する）
export function FieldForm(props: FieldFormProps) {
  const router = useRouter();
  const isEdit = props.mode === "edit";
  const fieldId = isEdit ? props.fieldId : null;
  const initial = isEdit ? props.initial : EMPTY_FIELD_INPUT;
  const detailHref = fieldId ? `/fields/${fieldId}` : "/fields";

  const [state, formAction, pending] = useActionState(
    async (prev: CreateFieldState, formData: FormData) => {
      const next = await (isEdit ? updateField(prev, formData) : createField(prev, formData));
      if (next.succeeded > prev.succeeded) {
        if (isEdit) router.replace(detailHref);
        else router.push("/fields");
      }
      return next;
    },
    { error: null, errors: {}, values: initial, succeeded: 0 },
  );

  // 編集: 圃場記号を変えようとしたら注意を出す（既存の株コードは変わらない）
  const [codeDraft, setCodeDraft] = useState(initial.code);
  const codeChanged = isEdit && isFieldCodeChanged(initial.code, codeDraft);

  return (
    <form
      key={state.succeeded}
      action={formAction}
      className="flex flex-col gap-4"
      noValidate
      aria-label={isEdit ? "圃場の編集" : "圃場の新規登録"}
      data-testid={isEdit ? "field-edit-form" : "field-form"}
    >
      {fieldId && <Input type="hidden" name="fieldId" value={fieldId} />}
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
          onChange={(e) => setCodeDraft(e.target.value)}
          autoComplete="off"
          autoCapitalize="characters"
          maxLength={4}
          className="max-w-32 font-mono"
          aria-invalid={state.errors.code ? true : undefined}
          aria-describedby={state.errors.code ? "field-error-code" : undefined}
        />
      </FormField>
      {codeChanged && (
        <Alert variant="warning" data-testid="field-code-change-notice">
          <AlertDescription>{FIELD_CODE_CHANGE_NOTICE}</AlertDescription>
        </Alert>
      )}
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
      <FormField id="field-notes" label="メモ" hint="省略可" error={state.errors.notes} errorId="field-error-notes">
        <Textarea
          id="field-notes"
          name="notes"
          defaultValue={state.values.notes}
          aria-invalid={state.errors.notes ? true : undefined}
          aria-describedby={state.errors.notes ? "field-error-notes" : undefined}
        />
      </FormField>
      {state.error && (
        <Alert variant="destructive" data-testid="field-error">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      {isEdit ? (
        <div className="flex gap-3">
          <Button type="submit" size="lg" className="flex-1" disabled={pending} data-testid="field-save">
            {pending ? "保存中…" : "保存"}
          </Button>
          <Button asChild variant="outline" size="lg" data-testid="field-edit-cancel">
            <Link href={detailHref}>キャンセル</Link>
          </Button>
        </div>
      ) : (
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "登録中…" : "登録"}
        </Button>
      )}
    </form>
  );
}
