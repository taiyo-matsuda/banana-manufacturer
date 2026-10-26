"use client";

import { useActionState, useState } from "react";
import { PlusIcon } from "lucide-react";
import { FormField } from "@/components/app/form-field";
import { NumberField } from "@/components/app/number-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOnline } from "@/lib/offline/use-online";
import type { RegisterStemState } from "@/lib/stems/registration";
import { registerStem } from "./actions";

// 株の詳細「茎を登録」フォーム。植え付け日（既定: 株の植え付け日）と初期葉数。
// 検証はサーバー側で行い、理由を画面に出す（noValidate）。成功したらフォームを閉じる。
// オンライン前提（Server Action）。圏外（オフラインの殻 2-9 を含む）ではボタンを無効にして理由を出す。
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
  const online = useOnline();
  // 成功した回数が増えたらフォームを閉じる（succeeded が state に乗る）
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const open = openedAt !== null && openedAt === state.succeeded;

  if (!open) {
    return (
      <div className="flex flex-col gap-3">
        {openedAt !== null && (
          <Alert variant="success" data-testid="stem-notice">
            <AlertDescription>茎を登録しました</AlertDescription>
          </Alert>
        )}
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={!online}
          onClick={() => setOpenedAt(state.succeeded)}
          data-testid="stem-add"
        >
          <PlusIcon aria-hidden="true" />
          茎を登録
        </Button>
        {!online && (
          <p className="text-sm text-muted-foreground" data-testid="stem-add-offline">
            茎の登録はオンラインで行ってください
          </p>
        )}
      </div>
    );
  }

  const label = nextGeneration === 1 ? "最初の茎（親）を登録" : `第 ${nextGeneration} 世代の茎を登録`;

  return (
    <form
      key={state.succeeded}
      action={formAction}
      className="flex flex-col gap-4 rounded-lg bg-muted/50 p-4 ring-1 ring-foreground/10"
      noValidate
      aria-label="茎の登録"
      data-testid="stem-form"
    >
      <p className="font-medium">{label}</p>
      <Input type="hidden" name="matId" value={matId} />
      <FormField id="stem-planted-at" label="植え付け日" error={state.errors.plantedAt} errorId="stem-error-plantedAt">
        <Input
          id="stem-planted-at"
          type="date"
          name="plantedAt"
          defaultValue={state.values.plantedAt}
          aria-invalid={state.errors.plantedAt ? true : undefined}
          aria-describedby={state.errors.plantedAt ? "stem-error-plantedAt" : undefined}
        />
      </FormField>
      <NumberField
        id="stem-initial-leaf-count"
        label="初期葉数"
        unit="枚"
        hint="植え付け（採用）時点の葉数。累計葉数の数え始めになる"
        min={0}
        step={1}
        name="initialLeafCount"
        defaultValue={state.values.initialLeafCount}
        error={state.errors.initialLeafCount}
        errorId="stem-error-initialLeafCount"
      />
      {state.error && (
        <Alert variant="destructive" data-testid="stem-error">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-3">
        <Button type="submit" size="lg" className="flex-1" disabled={pending || !online} data-testid="stem-submit">
          {pending ? "登録中…" : "登録"}
        </Button>
        <Button type="button" size="lg" variant="outline" disabled={pending} onClick={() => setOpenedAt(null)}>
          やめる
        </Button>
      </div>
    </form>
  );
}
