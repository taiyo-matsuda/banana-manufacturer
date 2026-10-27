"use client";

import { useActionState } from "react";
import { NumberField } from "@/components/app/number-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BASE_TEMP_MAX_C, BASE_TEMP_MIN_C } from "@/lib/gdd";
import type { PredictionParamsState } from "@/lib/fields/prediction-params";
import { savePredictionParams } from "./prediction-actions";

// 1 品種分の「予測の設定」の入力（3-2）。保存は prediction-actions.ts（field_cultivar_params に upsert）
export function PredictionParamsForm({
  fieldId,
  cultivarId,
  cultivarName,
  defaultBaseTemp,
  defaultTargetGdd,
  baseTemp,
  targetGdd,
}: {
  fieldId: string;
  cultivarId: string;
  cultivarName: string;
  defaultBaseTemp: string;
  defaultTargetGdd: string;
  baseTemp: string;
  targetGdd: string;
}) {
  const initial: PredictionParamsState = { error: null, errors: {}, values: { baseTemp, targetGdd }, saved: 0, attempts: 0, message: null };
  const [state, formAction, pending] = useActionState(savePredictionParams, initial);
  const idBase = `prediction-${cultivarId}`;

  return (
    <form action={formAction} className="flex flex-col gap-4" data-testid="prediction-params-form" data-cultivar={cultivarName}
      data-attempts={state.attempts}
      data-pending={pending ? "true" : "false"}
    >
      <Input type="hidden" name="fieldId" value={fieldId} />
      <Input type="hidden" name="cultivarId" value={cultivarId} />
      <p className="font-semibold">{cultivarName}</p>
      <NumberField
        // 保存のたびに入力欄を作り直して、保存した値を出す
        key={`base-${state.saved}`}
        id={`${idBase}-base`}
        name="baseTemp"
        label="基準温度"
        unit="℃"
        inputMode="decimal"
        step="any"
        placeholder={defaultBaseTemp}
        defaultValue={state.values.baseTemp}
        hint={`空欄なら品種の既定 ${defaultBaseTemp}℃。${BASE_TEMP_MIN_C}〜${BASE_TEMP_MAX_C}℃`}
        error={state.errors.baseTemp}
        errorTestId="prediction-base-temp-error"
        data-testid="prediction-base-temp"
      />
      <NumberField
        key={`target-${state.saved}`}
        id={`${idBase}-target`}
        name="targetGdd"
        label="目標積算温度（出蕾→収穫）"
        unit="℃・日"
        inputMode="decimal"
        step="any"
        placeholder={defaultTargetGdd}
        defaultValue={state.values.targetGdd}
        hint={`空欄なら品種の既定 ${defaultTargetGdd} ℃・日。収穫予測（ステップ 3）で使います`}
        error={state.errors.targetGdd}
        errorTestId="prediction-target-gdd-error"
        data-testid="prediction-target-gdd"
      />
      <Button type="submit" size="lg" disabled={pending} data-testid="prediction-save">
        {pending ? "保存中…" : "保存"}
      </Button>
      {state.message && (
        <p role="status" className="text-muted-foreground" data-testid="prediction-saved" data-saved={state.saved}>
          {state.message}
        </p>
      )}
      {state.error && (
        <Alert variant="destructive" data-testid="prediction-error">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
