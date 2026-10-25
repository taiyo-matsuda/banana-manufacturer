"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useActionState, useState } from "react";
import { FormField } from "@/components/app/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { type MatEditInput, SUCKER_TRANSPLANT_ORIGIN_LOCKED_REASON, type UpdateMatState } from "@/lib/mats/edit";
import { MAT_ORIGIN_LABELS, MAT_ORIGIN_TYPES } from "@/lib/mats/placement";
import { updateMat } from "./actions";

// 株の編集フォーム（UX-2）。株コード・品種・植え付け日・苗の種類。検証はサーバー側で行い、理由を画面に出す（noValidate）。
// 入力は state で持ち、送信は onSubmit から Action を呼ぶ（<form action> に渡すと React 19 が送信後にフォームを
// リセットし、エラーのときに入力が消える。1-8 の FAIL の原因）。保存できたら株の詳細へ戻る。
export function MatEditForm({
  matId,
  initial,
  originEditable,
  originLabel,
  cultivars,
}: {
  matId: string;
  initial: MatEditInput;
  // false: 株分けで作った株（苗の種類は変えられない）
  originEditable: boolean;
  // 変えられないときに表示する、いまの苗の種類
  originLabel: string;
  cultivars: { id: string; name: string }[];
}) {
  const router = useRouter();
  const detailHref = `/mats/${matId}`;
  const [values, setValues] = useState<MatEditInput>(initial);
  const [state, formAction, pending] = useActionState(
    async (prev: UpdateMatState, formData: FormData) => {
      const next = await updateMat(prev, formData);
      if (next.succeeded > prev.succeeded) router.replace(detailHref);
      return next;
    },
    { error: null, errors: {}, values: initial, succeeded: 0 },
  );

  const set = (patch: Partial<MatEditInput>) => setValues((v) => ({ ...v, ...patch }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        startTransition(() => formAction(formData));
      }}
      className="flex flex-col gap-4"
      noValidate
      aria-label="株の編集"
      data-testid="mat-edit-form"
    >
      <Input type="hidden" name="matId" value={matId} />
      <FormField
        id="mat-code"
        label="株コード"
        hint="この圃場の中で重ならないコード（前後の空白は取り除きます）"
        error={state.errors.code}
        errorId="mat-error-code"
      >
        <Input
          id="mat-code"
          type="text"
          name="code"
          value={values.code}
          onChange={(e) => set({ code: e.target.value })}
          autoComplete="off"
          autoCapitalize="characters"
          className="font-mono"
          aria-invalid={state.errors.code ? true : undefined}
          aria-describedby={state.errors.code ? "mat-error-code" : undefined}
        />
      </FormField>
      <FormField id="mat-cultivar" label="品種" error={state.errors.cultivarId} errorId="mat-error-cultivar">
        <NativeSelect
          id="mat-cultivar"
          name="cultivarId"
          value={values.cultivarId}
          onChange={(e) => set({ cultivarId: e.target.value })}
          aria-invalid={state.errors.cultivarId ? true : undefined}
          aria-describedby={state.errors.cultivarId ? "mat-error-cultivar" : undefined}
        >
          {cultivars.map((c) => (
            <NativeSelectOption key={c.id} value={c.id}>
              {c.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </FormField>
      <FormField
        id="mat-planted-at"
        label="植え付け日"
        hint="変えても、登録済みの茎の植え付け日は変わりません"
        error={state.errors.plantedAt}
        errorId="mat-error-plantedAt"
      >
        <Input
          id="mat-planted-at"
          type="date"
          name="plantedAt"
          value={values.plantedAt}
          onChange={(e) => set({ plantedAt: e.target.value })}
          aria-invalid={state.errors.plantedAt ? true : undefined}
          aria-describedby={state.errors.plantedAt ? "mat-error-plantedAt" : undefined}
        />
      </FormField>
      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium">苗の種類</legend>
        {originEditable ? (
          <RadioGroup
            name="originType"
            value={values.originType}
            onValueChange={(v) => set({ originType: v })}
            className="flex gap-6"
            aria-invalid={state.errors.originType ? true : undefined}
          >
            {MAT_ORIGIN_TYPES.map((t) => (
              // 行全体（ラベル）を押せるようにして、タップ領域を 44px 以上にする
              <Label
                key={t}
                htmlFor={`mat-origin-${t}`}
                className="min-h-11 cursor-pointer pr-2 font-normal"
                data-testid={`mat-origin-option-${t}`}
              >
                <RadioGroupItem id={`mat-origin-${t}`} value={t} />
                {MAT_ORIGIN_LABELS[t]}
              </Label>
            ))}
          </RadioGroup>
        ) : (
          <div className="flex flex-col gap-1" data-testid="mat-origin-locked">
            <p>{originLabel}</p>
            <p className="text-sm text-muted-foreground">{SUCKER_TRANSPLANT_ORIGIN_LOCKED_REASON}</p>
          </div>
        )}
        {state.errors.originType && (
          <p role="alert" data-testid="mat-error-originType" className="text-sm font-medium text-destructive">
            {state.errors.originType}
          </p>
        )}
      </fieldset>
      {state.error && (
        <Alert variant="destructive" data-testid="mat-edit-error">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-3">
        <Button type="submit" size="lg" className="flex-1" disabled={pending} data-testid="mat-save">
          {pending ? "保存中…" : "保存"}
        </Button>
        <Button asChild variant="outline" size="lg" data-testid="mat-edit-cancel">
          <Link href={detailHref}>キャンセル</Link>
        </Button>
      </div>
    </form>
  );
}
