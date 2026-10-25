"use client";

import { LngLatBounds, type Map as MapLibreMap, type MapMouseEvent, Marker } from "maplibre-gl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  addMatMarkers,
  attachPointerDrag,
  createFieldMap,
  makeGuideMarker,
  makeTapTarget,
  markMatMoved,
  setLatLngAttrs,
} from "@/components/app/field-map-core";
import { FormField } from "@/components/app/form-field";
import { NumberField } from "@/components/app/number-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { bearingDeg, distanceM, gridPoints, type LatLng } from "@/lib/geo";
import {
  MAT_ORIGIN_LABELS,
  MAT_ORIGIN_TYPES,
  type MatOriginType,
} from "@/lib/mats/placement";
import { applyPositionOverrides, extractMoves } from "@/lib/mats/relocate";
import { parseInitialLeafCount } from "@/lib/stems/registration";
import { placeMats, type PlacedMat, relocateMats } from "./actions";

export type FieldMapProps = {
  field: { id: string; name: string; code: string; centerLat: number; centerLng: number };
  mats: PlacedMat[];
  cultivars: { id: string; name: string }[];
  defaultCultivarId: string;
};

// 地図・株の点・目印は株分けの位置の指定（2-2）と共通（src/components/app/field-map-core.ts）

// 格子で配置: pick-origin → pick-direction → form → preview。1株追加: pick-single → single-form。
// 位置を直す（2-3）: relocate（既存の株の点をドラッグ → 確定 / 取り消し）。モード外では株の点はドラッグできない
type Mode =
  | "idle"
  | "pick-origin"
  | "pick-direction"
  | "form"
  | "preview"
  | "pick-single"
  | "single-form"
  | "relocate";

type GridForm = {
  rows: string;
  perRow: string;
  spacingM: string;
  cultivarId: string;
  plantedAt: string;
  originType: MatOriginType;
  // 初期葉数（省略可）。入れると株と同時に最初の茎も作る（1-5）
  initialLeafCount: string;
};

const DEFAULT_SPACING_M = "3";

function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function FieldMap({ field, mats: initialMats, cultivars, defaultCultivarId }: FieldMapProps) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const matMarkersRef = useRef<Marker[]>([]);
  const previewMarkersRef = useRef<Marker[]>([]);
  const modeRef = useRef<Mode>("idle");

  const [mapReady, setMapReady] = useState(false);
  // 確定で保存した株。サーバーのデータ（refresh 後）と合わせて表示する
  const [savedMats, setSavedMats] = useState<PlacedMat[]>([]);
  // 位置を直して確定した株の新しい位置（サーバーの再描画が届くまでの間も新しい位置に出す）
  const [savedPositions, setSavedPositions] = useState<ReadonlyMap<string, LatLng>>(() => new Map());
  const mats = useMemo(() => {
    const ids = new Set(initialMats.map((m) => m.id));
    return applyPositionOverrides([...initialMats, ...savedMats.filter((m) => !ids.has(m.id))], savedPositions);
  }, [initialMats, savedMats, savedPositions]);
  // 位置を直すモードで動かした株（id → 離した位置）。確定で差分だけを送る
  const [moved, setMoved] = useState<ReadonlyMap<string, LatLng>>(() => new Map());

  const [mode, setMode] = useState<Mode>("idle");
  const relocating = mode === "relocate";
  const [origin, setOrigin] = useState<LatLng | null>(null);
  const [direction, setDirection] = useState<LatLng | null>(null);
  // 1株追加でタップした位置
  const [singlePoint, setSinglePoint] = useState<LatLng | null>(null);
  // 生成した格子（ドラッグ後の位置はマーカーが持つ。確定時にマーカーから読む）
  const [preview, setPreview] = useState<LatLng[] | null>(null);
  const [form, setForm] = useState<GridForm>(() => ({
    rows: "1",
    perRow: "1",
    spacingM: DEFAULT_SPACING_M,
    cultivarId: defaultCultivarId,
    plantedAt: todayLocal(),
    originType: "tissue_culture",
    initialLeafCount: "",
  }));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  // 地図の click ハンドラは一度だけ登録するので、現在のモードは ref 経由で読む
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // 地図の初期化
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = createFieldMap(container, {
      center: { lat: field.centerLat, lng: field.centerLng },
      mats: initialMats,
      onReady: () => setMapReady(true),
    });

    map.on("click", (e: MapMouseEvent) => {
      const p = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      const m = modeRef.current;
      if (m === "pick-origin") {
        setOrigin(p);
        setMode("pick-direction");
      } else if (m === "pick-direction") {
        setDirection(p);
        setMode("form");
      } else if (m === "pick-single") {
        setSinglePoint(p);
        setMode("single-form");
      }
    });

    // 株の点（mat-marker）のタップで株の詳細へ。配置モード中は地図のタップとして扱う（上の click ハンドラ）。
    // マーカーごとにリスナーを付けず、コンテナで 1 つ受ける
    const onContainerClick = (ev: MouseEvent) => {
      if (modeRef.current !== "idle") return;
      const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-mat-id]");
      if (!target?.dataset.matId) return;
      router.push(`/mats/${target.dataset.matId}`);
    };
    container.addEventListener("click", onContainerClick);

    mapRef.current = map;
    return () => {
      container.removeEventListener("click", onContainerClick);
      map.remove();
      mapRef.current = null;
      matMarkersRef.current = [];
      previewMarkersRef.current = [];
      setMapReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.id]);

  // 1 点目・2 点目の目印は origin / direction の state から描く（地図が作り直されても state と一致する）
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const markers: Marker[] = [];
    if (origin) markers.push(makeGuideMarker(map, origin, "bg-blue-600", "origin"));
    if (direction) markers.push(makeGuideMarker(map, direction, "bg-sky-300", "direction"));
    if (singlePoint) markers.push(makeGuideMarker(map, singlePoint, "bg-amber-400", "single"));
    return () => {
      for (const m of markers) m.remove();
    };
  }, [origin, direction, singlePoint, mapReady]);

  // 既存の株を点で表示（色分けは 1-5 以降。いまは単色）。タップで株の詳細へ（配置モード中は地図のタップとして扱う）。
  // 位置を直すモードのときだけ、点にドラッグを付ける（モードを抜けると作り直すので、動かした位置は元に戻る）
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of matMarkersRef.current) m.remove();
    const markers = addMatMarkers(map, mats);
    matMarkersRef.current = markers;
    if (!relocating) return;
    const detach = markers.map((marker, i) => {
      const mat = mats[i];
      const el = marker.getElement();
      el.classList.add("cursor-grab");
      return attachPointerDrag(map, marker, el, (p) => {
        const changed = extractMoves([mat], new Map([[mat.id, p]])).length > 0;
        markMatMoved(el, changed);
        setMoved((prev) => {
          const next = new Map(prev);
          if (changed) next.set(mat.id, p);
          else next.delete(mat.id);
          return next;
        });
      });
    });
    return () => {
      for (const d of detach) d();
    };
  }, [mats, mapReady, relocating]);

  // プレビュー: 各点をドラッグできるマーカーで表示し、格子全体が見えるようにズームする
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !preview) return;

    const markers = preview.map((p, i) => {
      const el = makeTapTarget(
        "h-6 w-6 rounded-full border-2 border-white bg-amber-400 shadow",
        "cursor-grab active:cursor-grabbing",
      );
      el.dataset.testid = "preview-marker";
      el.dataset.index = String(i);
      setLatLngAttrs(el, p);
      const marker = new Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
      attachPointerDrag(map, marker, el);
      return marker;
    });
    previewMarkersRef.current = markers;

    const bounds = new LngLatBounds();
    for (const p of preview) bounds.extend([p.lng, p.lat]);
    map.fitBounds(bounds, { padding: 60, maxZoom: 21, duration: 0 });
    // フォームの入力で地図が画面外に流れていることがあるので、ドラッグできるように地図を見せる
    map.getContainer().scrollIntoView({ block: "start", behavior: "smooth" });

    return () => {
      for (const m of markers) m.remove();
      previewMarkersRef.current = [];
    };
  }, [preview]);

  function resetPicks() {
    setOrigin(null);
    setDirection(null);
    setSinglePoint(null);
    setPreview(null);
  }

  function startPlacement() {
    setError(null);
    setNotice(null);
    resetPicks();
    setMode("pick-origin");
  }

  function startSingle() {
    setError(null);
    setNotice(null);
    resetPicks();
    setMode("pick-single");
  }

  function cancelPlacement() {
    setError(null);
    resetPicks();
    setMoved(new Map());
    setMode("idle");
  }

  function startRelocate() {
    setError(null);
    setNotice(null);
    resetPicks();
    setMoved(new Map());
    setMode("relocate");
  }

  // 位置を直すモードの確定: 動かした株だけを 1 回の Server Action（RPC relocate_mats）で保存する
  function confirmRelocate() {
    const moves = extractMoves(mats, moved);
    if (moves.length === 0) return setError("動かした株がありません。株の点をドラッグしてください");
    setError(null);
    startSaving(async () => {
      const result = await relocateMats({ fieldId: field.id, moves });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSavedPositions((prev) => {
        const next = new Map(prev);
        for (const m of moves) next.set(m.matId, { lat: m.lat, lng: m.lng });
        return next;
      });
      setMoved(new Map());
      setNotice(`${moves.length} 株の位置を直しました`);
      setMode("idle");
    });
  }

  // 1株追加の確定。格子配置と同じ Server Action（placeMats）に 1 点だけ渡す（採番も同じ）
  function confirmSingle(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!singlePoint) return;
    if (!form.cultivarId) return setError("品種を選んでください");
    if (!form.plantedAt) return setError("植え付け日を入力してください");
    const leaves = parseInitialLeafCount(form.initialLeafCount);
    if (!leaves.ok) return setError(leaves.error);
    const point = singlePoint;
    setError(null);
    startSaving(async () => {
      const result = await placeMats({
        fieldId: field.id,
        cultivarId: form.cultivarId,
        plantedAt: form.plantedAt,
        originType: form.originType,
        points: [point],
        initialLeafCount: form.initialLeafCount,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSavedMats((prev) => [...prev, ...result.mats]);
      setNotice(`株 ${result.mats[0]?.code} を追加しました`);
      resetPicks();
      setMode("idle");
    });
  }

  function generatePreview(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!origin || !direction) return;
    const rows = Number(form.rows);
    const perRow = Number(form.perRow);
    const spacingM = Number(form.spacingM);
    if (!Number.isInteger(rows) || rows < 1) return setError("列数は 1 以上の整数で入力してください");
    if (!Number.isInteger(perRow) || perRow < 1)
      return setError("1 列の本数は 1 以上の整数で入力してください");
    if (!(spacingM > 0)) return setError("株間は 0 より大きい数で入力してください");
    if (!form.cultivarId) return setError("品種を選んでください");
    if (!form.plantedAt) return setError("植え付け日を入力してください");
    const leaves = parseInitialLeafCount(form.initialLeafCount);
    if (!leaves.ok) return setError(leaves.error);
    setError(null);
    const bearing = bearingDeg(origin, direction);
    setPreview(gridPoints({ origin, bearing, spacingM, rows, perRow }));
    setMode("preview");
  }

  function confirm() {
    const points = previewMarkersRef.current.map((m) => {
      const ll = m.getLngLat();
      return { lat: ll.lat, lng: ll.lng };
    });
    setError(null);
    startSaving(async () => {
      const result = await placeMats({
        fieldId: field.id,
        cultivarId: form.cultivarId,
        plantedAt: form.plantedAt,
        originType: form.originType,
        points,
        initialLeafCount: form.initialLeafCount,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSavedMats((prev) => [...prev, ...result.mats]);
      setNotice(`${result.mats.length} 株を保存しました（${result.mats[0]?.code}〜${result.mats.at(-1)?.code}）`);
      resetPicks();
      setMode("idle");
    });
  }

  const statusText: Record<Mode, string> = {
    idle: "",
    "pick-origin": "最初の株の位置を地図でタップしてください（1 点目）",
    "pick-direction": "列の向きを決める点を地図でタップしてください（2 点目）",
    form: "列数・本数などを入力してプレビューを表示します",
    preview: "点をドラッグして位置を直し、よければ確定してください",
    "pick-single": "株を追加する位置を地図でタップしてください",
    "single-form": "品種などを入力して確定すると、タップした位置に株を 1 つ追加します",
    relocate: "動かしたい株の点をドラッグしてください。確定すると、動かした株だけ位置を保存します",
  };

  // 格子配置と 1株追加で共通の入力（品種・植え付け日・苗の種類）
  const commonFields = (
    <>
      <FormField id="place-cultivar" label="品種">
        <NativeSelect
          id="place-cultivar"
          name="cultivarId"
          value={form.cultivarId}
          onChange={(e) => setForm({ ...form, cultivarId: e.target.value })}
        >
          {cultivars.map((c) => (
            <NativeSelectOption key={c.id} value={c.id}>
              {c.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </FormField>
      <FormField id="place-planted-at" label="植え付け日">
        <Input
          id="place-planted-at"
          type="date"
          name="plantedAt"
          value={form.plantedAt}
          onChange={(e) => setForm({ ...form, plantedAt: e.target.value })}
        />
      </FormField>
      <fieldset className="flex flex-col gap-2">
        <legend className="font-medium">苗の種類</legend>
        <RadioGroup
          name="originType"
          value={form.originType}
          onValueChange={(v) => setForm({ ...form, originType: v as MatOriginType })}
          className="flex gap-6"
        >
          {MAT_ORIGIN_TYPES.map((t) => (
            <div key={t} className="flex min-h-11 items-center gap-2">
              <RadioGroupItem id={`place-origin-${t}`} value={t} />
              <Label htmlFor={`place-origin-${t}`} className="font-normal">
                {MAT_ORIGIN_LABELS[t]}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </fieldset>
      <NumberField
        id="place-initial-leaf-count"
        label="初期葉数"
        unit="枚"
        hint="入れると株と同時に最初の茎も登録する（全株に同じ値。例外は株の詳細で直す）。省略すると茎は後から株の詳細で登録する"
        min={0}
        step={1}
        name="initialLeafCount"
        value={form.initialLeafCount}
        onChange={(e) => setForm({ ...form, initialLeafCount: e.target.value })}
        placeholder="省略可"
      />
    </>
  );

  const directionInfo =
    origin && direction
      ? `方位 ${bearingDeg(origin, direction).toFixed(0)}°、2 点間 ${distanceM(origin, direction).toFixed(1)} m`
      : null;

  return (
    <div className="flex flex-1 flex-col">
      <div
        ref={containerRef}
        data-testid="field-map"
        data-map-ready={mapReady ? "true" : "false"}
        data-mode={mode}
        className="h-[55vh] min-h-72 w-full bg-muted"
        aria-label="圃場マップ"
      />

      <section className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-4">
        <p className="text-muted-foreground" data-testid="mat-count">
          株 {mats.length}
        </p>

        {mode === "idle" && (
          <div className="flex flex-col gap-3">
            <Button type="button" size="lg" onClick={startPlacement}>
              配置を始める
            </Button>
            <Button type="button" size="lg" variant="outline" onClick={startSingle}>
              1株追加
            </Button>
            <Button
              type="button"
              size="lg"
              variant="outline"
              onClick={startRelocate}
              disabled={mats.length === 0}
              data-testid="relocate-start"
            >
              位置を直す
            </Button>
          </div>
        )}

        {mode !== "idle" && (
          <Alert data-testid="place-status" aria-live="polite">
            <AlertDescription>{statusText[mode]}</AlertDescription>
          </Alert>
        )}

        {mode === "single-form" && (
          <Card>
            <CardContent>
              <form className="flex flex-col gap-4" onSubmit={confirmSingle} noValidate>
                {commonFields}
                <Button type="submit" size="lg" disabled={saving} data-testid="single-confirm">
                  {saving ? "保存中…" : "確定（1 株）"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {(mode === "form" || mode === "preview") && (
          <Card>
            <CardContent>
              <form className="flex flex-col gap-4" onSubmit={generatePreview} noValidate>
                {directionInfo && <p className="text-sm text-muted-foreground">{directionInfo}</p>}
                <div className="grid grid-cols-3 gap-3">
                  <NumberField
                    id="place-rows"
                    label="列数"
                    min={1}
                    name="rows"
                    value={form.rows}
                    onChange={(e) => setForm({ ...form, rows: e.target.value })}
                  />
                  <NumberField
                    id="place-per-row"
                    label="1列の本数"
                    min={1}
                    name="perRow"
                    value={form.perRow}
                    onChange={(e) => setForm({ ...form, perRow: e.target.value })}
                  />
                  <NumberField
                    id="place-spacing"
                    label="株間（m）"
                    inputMode="decimal"
                    min={0.1}
                    step={0.1}
                    name="spacingM"
                    value={form.spacingM}
                    onChange={(e) => setForm({ ...form, spacingM: e.target.value })}
                  />
                </div>
                {commonFields}
                <div className="flex gap-3">
                  <Button type="submit" size="lg" variant="outline" className="flex-1" disabled={saving}>
                    プレビュー
                  </Button>
                  {mode === "preview" && (
                    <Button type="button" size="lg" className="flex-1" onClick={confirm} disabled={saving} data-testid="place-confirm">
                      {saving ? "保存中…" : `確定（${preview?.length ?? 0} 株）`}
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>
        )}

        {relocating && (
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground" data-testid="relocate-moved-count">
              動かした株 {moved.size}
            </p>
            <div className="flex gap-3">
              <Button
                type="button"
                size="lg"
                variant="outline"
                className="flex-1"
                onClick={cancelPlacement}
                disabled={saving}
                data-testid="relocate-cancel"
              >
                取り消し
              </Button>
              <Button
                type="button"
                size="lg"
                className="flex-1"
                onClick={confirmRelocate}
                disabled={saving || moved.size === 0}
                data-testid="relocate-confirm"
              >
                {saving ? "保存中…" : `確定（${moved.size} 株）`}
              </Button>
            </div>
          </div>
        )}

        {mode !== "idle" && !relocating && (
          <Button type="button" size="lg" variant="outline" onClick={cancelPlacement} disabled={saving}>
            やめる
          </Button>
        )}

        {error && (
          <Alert variant="destructive" data-testid="place-error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {notice && (
          <Alert variant="success" data-testid="place-notice">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
      </section>
    </div>
  );
}
