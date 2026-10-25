"use client";

import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { FormField } from "@/components/app/form-field";
import { NumberField } from "@/components/app/number-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { LatLng } from "@/lib/geo";
import { checkFreePosition } from "@/lib/mats/transplant";
import { useOnline } from "@/lib/offline/use-online";
import { parseRequiredInitialLeafCount } from "@/lib/stemEvents";
import { transplantSucker } from "./actions";

// MapLibre はブラウザでしか動かないので SSR を切る（ssr: false は Client Component の中でだけ使える）
const PointPickerMap = dynamic(() => import("@/components/app/point-picker-map").then((m) => m.PointPickerMap), {
  ssr: false,
  loading: () => (
    <p className="py-6 text-muted-foreground" data-testid="map-loading">
      地図を読み込み中…
    </p>
  ),
});

type MapMat = { id: string; code: string; lat: number; lng: number };

// 株分けの入力（page.tsx の説明を参照）。転出先の圃場を変えると ?field= で画面を読み直す（地図・株・採番がその圃場になる）。
// 確定の id（イベント・新しい株・新しい茎）は最初の確定で 1 回だけ採番し、再試行でも同じ id を使う
// （失敗した確定は RPC のトランザクションごと取り消されているので、同じ id で送り直してよい）。
export function TransplantForm({
  stemId,
  fields,
  target,
  mats,
  proposedCode,
}: {
  stemId: string;
  fields: { id: string; name: string; code: string }[];
  target: { id: string; name: string; code: string; centerLat: number; centerLng: number };
  mats: MapMat[];
  proposedCode: string;
}) {
  const router = useRouter();
  const online = useOnline();
  const [point, setPoint] = useState<LatLng | null>(null);
  const [leaves, setLeaves] = useState("");
  const [code, setCode] = useState(proposedCode);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(false);
  const [saving, startSaving] = useTransition();
  const [changingField, startChangingField] = useTransition();
  const ids = useRef<{ eventId: string; newMatId: string; newStemId: string } | null>(null);

  // 圃場を変えたら採番は読み直した画面の値に（state を props に合わせる。React の「adjusting state when a prop changes」）
  const [trackedCode, setTrackedCode] = useState(proposedCode);
  if (trackedCode !== proposedCode) {
    setTrackedCode(proposedCode);
    setCode(proposedCode);
    setRetry(false);
  }

  const pick = (p: LatLng) => {
    const check = checkFreePosition(p, mats);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setError(null);
    setPoint(p);
  };

  const changeField = (fieldId: string) => {
    setPoint(null);
    setError(null);
    startChangingField(() => {
      router.replace(`/stems/${stemId}/transplant?field=${fieldId}`, { scroll: false });
    });
  };

  const submit = () => {
    if (saving) return;
    if (!point) return setError("転出先の位置を地図でタップしてください");
    const parsed = parseRequiredInitialLeafCount(leaves);
    if (!parsed.ok) return setError(parsed.error);
    ids.current ??= { eventId: crypto.randomUUID(), newMatId: crypto.randomUUID(), newStemId: crypto.randomUUID() };
    const sent = { ...ids.current };
    setError(null);
    startSaving(async () => {
      const result = await transplantSucker({
        ...sent,
        stemId,
        toFieldId: target.id,
        lat: point.lat,
        lng: point.lng,
        code,
        initialLeafCount: leaves,
      });
      if (!result.ok) {
        setError(result.error);
        if (result.conflict) {
          setCode(result.conflict.nextCode);
          setRetry(true);
        }
        return;
      }
      router.push(`/mats/${result.matId}`);
    });
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      noValidate
    >
      <FormField id="transplant-field" label="転出先の圃場">
        <NativeSelect
          id="transplant-field"
          value={target.id}
          onChange={(e) => changeField(e.target.value)}
          disabled={changingField || saving}
          data-testid="transplant-field"
        >
          {fields.map((f) => (
            <NativeSelectOption key={f.id} value={f.id}>
              {f.name}（{f.code}）
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </FormField>

      <div className="flex flex-col gap-2">
        <p className="text-base font-medium">植え替える位置</p>
        <p className="text-sm text-muted-foreground" data-testid="transplant-hint">
          {point ? "位置を選びました。タップし直すと変えられます" : "地図の空いている位置をタップしてください"}
        </p>
        {/* 圃場を変えたら地図を作り直す */}
        <div className="-mx-4">
          <PointPickerMap
            key={target.id}
            center={{ lat: target.centerLat, lng: target.centerLng }}
            mats={mats}
            value={point}
            onPick={pick}
          />
        </div>
      </div>

      <NumberField
        id="transplant-leaves"
        label="初期葉数"
        unit="枚"
        min={0}
        step={1}
        value={leaves}
        onChange={(e) => setLeaves(e.target.value)}
        data-testid="transplant-leaves"
      />

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">新しい株</dt>
        <dd className="font-mono" data-testid="transplant-code">
          {code}
        </dd>
        <dt className="text-muted-foreground">植え付け日</dt>
        <dd>今日</dd>
      </dl>

      {error && (
        <Alert variant="destructive" data-testid="transplant-error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {!online && (
        <Alert variant="warning" data-testid="transplant-offline">
          <AlertDescription>株分けは新しい株を作るため、オンラインのときだけできます</AlertDescription>
        </Alert>
      )}

      <Button type="submit" size="lg" disabled={saving || changingField || !online} data-testid="transplant-submit">
        {saving ? "保存中…" : retry ? `${code} で再試行` : "確定"}
      </Button>
    </form>
  );
}
