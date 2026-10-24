"use client";

import {
  LngLatBounds,
  Map as MapLibreMap,
  type MapMouseEvent,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
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
import { parseInitialLeafCount } from "@/lib/stems/registration";
import { placeMats, type PlacedMat } from "./actions";

export type FieldMapProps = {
  field: { id: string; name: string; code: string; centerLat: number; centerLng: number };
  mats: PlacedMat[];
  cultivars: { id: string; name: string }[];
  defaultCultivarId: string;
};

// 地理院タイル 空中写真（最大ズーム 18。それ以上は拡大表示）
const GSI_PHOTO_TILES = "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg";
const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">地理院タイル（国土地理院）</a>';
const INITIAL_ZOOM = 18;
const MAX_ZOOM = 22;

// MapLibre の Web Worker。バンドラ経由では既定の場所（import.meta.url の隣）に無いので、
// scripts/copy-maplibre-worker.mjs が public/ に置いたものを使う
const MAPLIBRE_WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";
if (typeof window !== "undefined") setWorkerUrl(MAPLIBRE_WORKER_URL);

// 格子で配置: pick-origin → pick-direction → form → preview。1株追加: pick-single → single-form
type Mode =
  | "idle"
  | "pick-origin"
  | "pick-direction"
  | "form"
  | "preview"
  | "pick-single"
  | "single-form";

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

function setLatLngAttrs(el: HTMLElement, p: LatLng) {
  el.dataset.lat = String(p.lat);
  el.dataset.lng = String(p.lng);
}

function makeDot(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

// タップできる点（株・プレビュー）: 見た目の点は小さいまま、透明な 44px の当たり判定で包む（UX-1 完了条件 6）。
// data-* やイベントは外側（当たり判定）に付ける。MapLibre の Marker は要素の中心を座標に合わせるので位置は変わらない
function makeTapTarget(dotClassName: string, extraClassName = ""): HTMLDivElement {
  const el = makeDot(`flex size-11 items-center justify-center ${extraClassName}`);
  el.appendChild(makeDot(`pointer-events-none ${dotClassName}`));
  return el;
}

// 配置モードで選んだ 1 点目・2 点目の目印
function makeGuideMarker(map: MapLibreMap, p: LatLng, color: string, kind: string): Marker {
  const el = makeDot(`h-3 w-3 rounded-full border-2 border-white shadow ${color}`);
  el.dataset.testid = `guide-marker-${kind}`;
  setLatLngAttrs(el, p);
  return new Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
}

// プレビュー点のドラッグ（Pointer Events で自前実装。マウスとタッチの両方で同じ動き）。
// ポインタを押した位置と点の位置のずれを保ち、点が指に飛びつかないようにする
function attachPointerDrag(map: MapLibreMap, marker: Marker, el: HTMLElement) {
  let dragging = false;
  let dx = 0;
  let dy = 0;

  const toMapPoint = (ev: PointerEvent) => {
    const rect = map.getContainer().getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  el.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0 && ev.pointerType === "mouse") return;
    ev.preventDefault();
    ev.stopPropagation();
    const p = toMapPoint(ev);
    const pos = map.project(marker.getLngLat());
    dx = pos.x - p.x;
    dy = pos.y - p.y;
    dragging = true;
    // pointer が既に無効なときは例外になる（その場合はキャプチャ無しで続ける）
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      // キャプチャできなくても pointermove / pointerup は要素上で受けられる
    }
    el.classList.add("cursor-grabbing");
  });
  el.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    ev.preventDefault();
    const p = toMapPoint(ev);
    const ll = map.unproject([p.x + dx, p.y + dy]);
    marker.setLngLat(ll);
    setLatLngAttrs(el, { lat: ll.lat, lng: ll.lng });
  });
  const end = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("cursor-grabbing");
    if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  // 地図のパン・タップ（mousedown / touchstart）に伝えない
  el.addEventListener("mousedown", (ev) => ev.stopPropagation());
  el.addEventListener("touchstart", (ev) => ev.stopPropagation(), { passive: true });
  el.style.touchAction = "none";
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
  const mats = useMemo(() => {
    const ids = new Set(initialMats.map((m) => m.id));
    return [...initialMats, ...savedMats.filter((m) => !ids.has(m.id))];
  }, [initialMats, savedMats]);
  const [mode, setMode] = useState<Mode>("idle");
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

    const map = new MapLibreMap({
      container,
      style: {
        version: 8,
        sources: {
          gsi: {
            type: "raster",
            tiles: [GSI_PHOTO_TILES],
            tileSize: 256,
            maxzoom: 18,
            attribution: GSI_ATTRIBUTION,
          },
        },
        layers: [{ id: "gsi", type: "raster", source: "gsi" }],
      },
      center: [field.centerLng, field.centerLat],
      zoom: INITIAL_ZOOM,
      maxZoom: MAX_ZOOM,
      // 出典は常時表示（compact にしない）
      attributionControl: { compact: false },
    });
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.on("style.load", () => setMapReady(true));

    // 既に株があれば、株全体が見えて 1 株ずつタップできるズームにする（初期ズーム 18 では 3m 間隔の株がほぼ重なる）
    if (initialMats.length > 0) {
      const bounds = new LngLatBounds();
      for (const m of initialMats) bounds.extend([m.lng, m.lat]);
      map.fitBounds(bounds, { padding: 60, maxZoom: 21, duration: 0 });
    }

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

  // 既存の株を点で表示（色分けは 1-5 以降。いまは単色）。タップで株の詳細へ（配置モード中は地図のタップとして扱う）
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of matMarkersRef.current) m.remove();
    matMarkersRef.current = mats.map((mat) => {
      const el = makeTapTarget(
        "h-3.5 w-3.5 rounded-full border-2 border-white bg-green-500 shadow",
        "cursor-pointer",
      );
      el.dataset.testid = "mat-marker";
      // mat.id をそのまま dataset / setAttribute に渡すと React Compiler の lint（react-hooks/immutability）が
      // 「mats を変更するかもしれない」と誤判定するので、文字列に写してから付ける
      el.setAttribute("data-mat-id", `${mat.id}`);
      el.dataset.code = mat.code;
      el.title = mat.code;
      el.role = "link";
      el.ariaLabel = `株 ${mat.code}`;
      setLatLngAttrs(el, mat);
      return new Marker({ element: el }).setLngLat([mat.lng, mat.lat]).addTo(map);
    });
  }, [mats, mapReady]);

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
    setMode("idle");
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

        {mode !== "idle" && (
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
