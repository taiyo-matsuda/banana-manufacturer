"use client";

import { useActionState } from "react";
import { NumberField } from "@/components/app/number-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BAG_AFTER_DAYS_DEFAULT,
  BAG_AFTER_DAYS_MAX,
  BAG_AFTER_DAYS_MIN,
  HARVEST_WINDOW_DAYS_DEFAULT,
  HARVEST_WINDOW_DAYS_MAX,
  HARVEST_WINDOW_DAYS_MIN,
  type RecommendationParamsState,
} from "@/lib/recommendations/settings";
import { saveRecommendationParams } from "./recommendation-actions";

// 「提案の設定」の入力（3-4）。保存は recommendation-actions.ts（field_recommendation_params に upsert → 提案の再評価）
export function RecommendationParamsForm({
  fieldId,
  bagAfterDays,
  harvestWindowDays,
}: {
  fieldId: string;
  bagAfterDays: string;
  harvestWindowDays: string;
}) {
  const initial: RecommendationParamsState = {
    error: null,
    errors: {},
    values: { bagAfterDays, harvestWindowDays },
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
