"use client";

import { useActionState } from "react";
import { FormField } from "@/components/app/form-field";
import { NumberField } from "@/components/app/number-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { DEFAULT_FERTILIZER_UNIT, FERTILIZER_UNITS } from "@/lib/fertilize";
import {
  BAG_AFTER_DAYS_DEFAULT,
  BAG_AFTER_DAYS_MAX,
  BAG_AFTER_DAYS_MIN,
  DEAD_LEAVES_INTERVAL_DAYS_DEFAULT,
  DEAD_LEAVES_INTERVAL_DAYS_MAX,
  DEAD_LEAVES_INTERVAL_DAYS_MIN,
  FERTILIZE_AFTER_HARVEST_DAYS_DEFAULT,
  FERTILIZE_AFTER_HARVEST_DAYS_MAX,
  FERTILIZE_AFTER_HARVEST_DAYS_MIN,
  HARVEST_WINDOW_DAYS_DEFAULT,
  HARVEST_WINDOW_DAYS_MAX,
  HARVEST_WINDOW_DAYS_MIN,
  type RecommendationParamsInput,
  type RecommendationParamsState,
} from "@/lib/recommendations/settings";
import { saveRecommendationParams } from "./recommendation-actions";

// 「提案の設定」の入力（3-4・3-5）。保存は recommendation-actions.ts（field_recommendation_params に upsert → 提案の再評価）
export function RecommendationParamsForm({ fieldId, values }: { fieldId: string; values: RecommendationParamsInput }) {
  const initial: RecommendationParamsState = {
    error: null,
    errors: {},
    values,
    saved: 0,
    attempts: 0,
    message: null,
  };
  const [state, formAction, pending] = useActionState(saveRecommendationParams, initial);

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4"
      data-testid="recommendation-params-form"
      data-attempts={state.attempts}
      data-pending={pending ? "true" : "false"}
    >
      <Input type="hidden" name="fieldId" value={fieldId} />
      <NumberField
        // 保存のたびに入力欄を作り直して、保存した値を出す
        key={`bag-${state.saved}`}
        id="recommendation-bag-after-days"
        name="bagAfterDays"
        label="袋掛け・摘蕾（出蕾から）"
        unit="日"
        inputMode="numeric"
        step="1"
        placeholder={String(BAG_AFTER_DAYS_DEFAULT)}
        defaultValue={state.values.bagAfterDays}
        hint={`出蕾からこの日数たったら提案します。空欄なら ${BAG_AFTER_DAYS_DEFAULT} 日。${BAG_AFTER_DAYS_MIN}〜${BAG_AFTER_DAYS_MAX} 日`}
        error={state.errors.bagAfterDays}
        errorTestId="recommendation-bag-after-days-error"
        data-testid="recommendation-bag-after-days"
      />
      <NumberField
        key={`harvest-${state.saved}`}
        id="recommendation-harvest-window-days"
        name="harvestWindowDays"
        label="収穫期（収穫予測の早い日の何日前から）"
        unit="日"
        inputMode="numeric"
        step="1"
        placeholder={String(HARVEST_WINDOW_DAYS_DEFAULT)}
        defaultValue={state.values.harvestWindowDays}
        hint={`空欄なら ${HARVEST_WINDOW_DAYS_DEFAULT} 日前。${HARVEST_WINDOW_DAYS_MIN}〜${HARVEST_WINDOW_DAYS_MAX} 日`}
        error={state.errors.harvestWindowDays}
        errorTestId="recommendation-harvest-window-days-error"
        data-testid="recommendation-harvest-window-days"
      />
      <NumberField
        key={`fertilize-${state.saved}`}
        id="recommendation-fertilize-after-harvest-days"
        name="fertilizeAfterHarvestDays"
        label="収穫後の追肥（収穫から何日以内）"
        unit="日"
        inputMode="numeric"
        step="1"
        placeholder={String(FERTILIZE_AFTER_HARVEST_DAYS_DEFAULT)}
        defaultValue={state.values.fertilizeAfterHarvestDays}
        hint={`収穫を記録したら提案し、期限は収穫日からこの日数。空欄なら ${FERTILIZE_AFTER_HARVEST_DAYS_DEFAULT} 日。${FERTILIZE_AFTER_HARVEST_DAYS_MIN}〜${FERTILIZE_AFTER_HARVEST_DAYS_MAX} 日`}
        error={state.errors.fertilizeAfterHarvestDays}
        errorTestId="recommendation-fertilize-after-harvest-days-error"
        data-testid="recommendation-fertilize-after-harvest-days"
      />
      <div className="grid grid-cols-[1fr_auto] items-start gap-3">
        <NumberField
          key={`amount-${state.saved}`}
          id="recommendation-standard-amount"
          name="standardAmount"
          label="追肥の標準量（1 株あたり）"
          inputMode="decimal"
          step="any"
          min="0"
          defaultValue={state.values.standardAmount}
          hint="収穫後の追肥の提案に出します。空欄なら量を出しません"
          error={state.errors.standardAmount}
          errorTestId="recommendation-standard-amount-error"
          data-testid="recommendation-standard-amount"
        />
        <FormField
          id="recommendation-standard-unit"
          label="単位"
          error={state.errors.standardUnit}
          errorTestId="recommendation-standard-unit-error"
        >
          <NativeSelect
            key={`unit-${state.saved}`}
            id="recommendation-standard-unit"
            name="standardUnit"
            className="w-28"
            defaultValue={state.values.standardUnit || DEFAULT_FERTILIZER_UNIT}
            data-testid="recommendation-standard-unit"
          >
            {FERTILIZER_UNITS.map((u) => (
              <NativeSelectOption key={u} value={u}>
                {u}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </FormField>
      </div>
      <NumberField
        key={`dead-leaves-${state.saved}`}
        id="recommendation-dead-leaves-interval-days"
        name="deadLeavesIntervalDays"
        label="枯葉処理の間隔"
        unit="日"
        inputMode="numeric"
        step="1"
        placeholder={String(DEAD_LEAVES_INTERVAL_DAYS_DEFAULT)}
        defaultValue={state.values.deadLeavesIntervalDays}
        hint={`最後の枯葉処理（なければ採用・植え付け）からこの日数たったら提案します。空欄なら ${DEAD_LEAVES_INTERVAL_DAYS_DEFAULT} 日。${DEAD_LEAVES_INTERVAL_DAYS_MIN}〜${DEAD_LEAVES_INTERVAL_DAYS_MAX} 日`}
        error={state.errors.deadLeavesIntervalDays}
        errorTestId="recommendation-dead-leaves-interval-days-error"
        data-testid="recommendation-dead-leaves-interval-days"
      />
      <Button type="submit" size="lg" disabled={pending} data-testid="recommendation-params-save">
        {pending ? "保存中…" : "保存"}
      </Button>
      {state.message && (
        <p role="status" className="text-muted-foreground" data-testid="recommendation-params-saved" data-saved={state.saved}>
          {state.message}
        </p>
      )}
      {state.error && (
        <Alert variant="destructive" data-testid="recommendation-params-error">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
