"use client";

import { RefreshCwIcon } from "lucide-react";
import { useActionState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { INITIAL_WEATHER_NOW_STATE } from "@/lib/weather/now-state";
import { syncWeatherNow } from "./weather-actions";

// 「今すぐ取り込む」（3-1）。日次の取り込みと同じ処理を 1 圃場だけ。10 年分の平年値の材料が未取得だと十数秒かかる
export function WeatherSyncButton({ fieldId }: { fieldId: string }) {
  const [state, formAction, pending] = useActionState(syncWeatherNow, INITIAL_WEATHER_NOW_STATE);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Input type="hidden" name="fieldId" value={fieldId} />
      <Button type="submit" variant="outline" size="lg" disabled={pending} data-testid="weather-sync-now">
        <RefreshCwIcon aria-hidden="true" className={pending ? "animate-spin" : undefined} />
        {pending ? "取り込み中…" : "気温を今すぐ取り込む"}
      </Button>
      {state.message && (
        <p role="status" className="text-muted-foreground" data-testid="weather-sync-message" data-done={state.done}>
          {state.message}
        </p>
      )}
      {state.error && (
        <Alert variant="destructive" data-testid="weather-sync-error" data-done={state.done}>
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
