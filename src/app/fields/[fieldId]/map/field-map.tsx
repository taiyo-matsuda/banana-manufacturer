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
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { bearingDeg, distanceM, gridPoints, type LatLng } from "@/lib/geo";
import {
  MAT_ORIGIN_LABELS,
  MAT_ORIGIN_TYPES,
  type MatOriginType,
} from "@/lib/mats/placement";
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

type Mode = "idle" | "pick-origin" | "pick-direction" | "form" | "preview";

type GridForm = {
  rows: string;
  perRow: string;
  spacingM: string;
  cultivarId: string;
  plantedAt: string;
  originType: MatOriginType;
};

const DEFAULT_SPACING_M = "3";

function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const inputClass =
  "h-12 w-full rounded-lg border border-zinc-300 px-3 text-base dark:border-zinc-700 dark:bg-zinc-900";
const primaryButtonClass =
  "h-12 rounded-lg bg-green-700 px-4 text-base font-medium text-white disabled:opacity-60";
const secondaryButtonClass =
  "h-12 rounded-lg border border-zinc-300 px-4 text-base dark:border-zinc-700 disabled:opacity-60";

function setLatLngAttrs(el: HTMLElement, p: LatLng) {
  el.dataset.lat = String(p.lat);
  el.dataset.lng = String(p.lng);
}

function makeDot(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
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
  // 生成した格子（ドラッグ後の位置はマーカーが持つ。確定時にマーカーから読む）
  const [preview, setPreview] = useState<LatLng[] | null>(null);
  const [form, setForm] = useState<GridForm>(() => ({
    rows: "1",
    perRow: "1",
    spacingM: DEFAULT_SPACING_M,
    cultivarId: defaultCultivarId,
    plantedAt: todayLocal(),
    originType: "tissue_culture",
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

    map.on("click", (e: MapMouseEvent) => {
      const p = { lat: e.lngLat.lat, lng: e.lngLat.lng };
      const m = modeRef.current;
      if (m === "pick-origin") {
        setOrigin(p);
        setMode("pick-direction");
      } else if (m === "pick-direction") {
        setDirection(p);
        setMode("form");
      }
    });

    mapRef.current = map;
    return () => {
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
    return () => {
      for (const m of markers) m.remove();
    };
  }, [origin, direction, mapReady]);

  // 既存の株を点で表示（色分けは 1-5 以降。いまは単色）
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of matMarkersRef.current) m.remove();
    matMarkersRef.current = mats.map((mat) => {
      const el = makeDot("h-3.5 w-3.5 rounded-full border-2 border-white bg-green-500 shadow");
      el.dataset.testid = "mat-marker";
      el.dataset.code = mat.code;
      el.title = mat.code;
      setLatLngAttrs(el, mat);
      return new Marker({ element: el }).setLngLat([mat.lng, mat.lat]).addTo(map);
    });
  }, [mats, mapReady]);

  // プレビュー: 各点をドラッグできるマーカーで表示し、格子全体が見えるようにズームする
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !preview) return;

    const markers = preview.map((p, i) => {
      const el = makeDot(
        "h-6 w-6 cursor-grab rounded-full border-2 border-white bg-amber-400 shadow active:cursor-grabbing",
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

  function startPlacement() {
    setError(null);
    setNotice(null);
    setOrigin(null);
    setDirection(null);
    setPreview(null);
    setMode("pick-origin");
  }

  function cancelPlacement() {
    setError(null);
    setOrigin(null);
    setDirection(null);
    setPreview(null);
    setMode("idle");
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
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSavedMats((prev) => [...prev, ...result.mats]);
      setNotice(`${result.mats.length} 株を保存しました（${result.mats[0]?.code}〜${result.mats.at(-1)?.code}）`);
      setOrigin(null);
      setDirection(null);
      setPreview(null);
        setMode("idle");
    });
  }

  const statusText: Record<Mode, string> = {
    idle: "",
    "pick-origin": "最初の株の位置を地図でタップしてください（1 点目）",
    "pick-direction": "列の向きを決める点を地図でタップしてください（2 点目）",
    form: "列数・本数などを入力してプレビューを表示します",
    preview: "点をドラッグして位置を直し、よければ確定してください",
  };

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
        className="h-[55vh] min-h-72 w-full bg-zinc-200 dark:bg-zinc-800"
        aria-label="圃場マップ"
      />

      <section className="mx-auto flex w-full max-w-md flex-col gap-3 px-4 py-4">
        <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="mat-count">
          株 {mats.length}
        </p>

        {mode === "idle" && (
          <button type="button" className={primaryButtonClass} onClick={startPlacement}>
            配置を始める
          </button>
        )}

        {mode !== "idle" && (
          <p className="text-sm" data-testid="place-status" aria-live="polite">
            {statusText[mode]}
          </p>
        )}

        {(mode === "form" || mode === "preview") && (
          <form className="flex flex-col gap-3" onSubmit={generatePreview} noValidate>
            {directionInfo && <p className="text-xs text-zinc-500">{directionInfo}</p>}
            <div className="grid grid-cols-3 gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span>列数</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  name="rows"
                  value={form.rows}
                  onChange={(e) => setForm({ ...form, rows: e.target.value })}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>1列の本数</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  name="perRow"
                  value={form.perRow}
                  onChange={(e) => setForm({ ...form, perRow: e.target.value })}
                  className={inputClass}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>株間（m）</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0.1}
                  step={0.1}
                  name="spacingM"
                  value={form.spacingM}
                  onChange={(e) => setForm({ ...form, spacingM: e.target.value })}
                  className={inputClass}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-sm">
              <span>品種</span>
              <select
                name="cultivarId"
                value={form.cultivarId}
                onChange={(e) => setForm({ ...form, cultivarId: e.target.value })}
                className={inputClass}
              >
                {cultivars.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>植え付け日</span>
              <input
                type="date"
                name="plantedAt"
                value={form.plantedAt}
                onChange={(e) => setForm({ ...form, plantedAt: e.target.value })}
                className={inputClass}
              />
            </label>
            <fieldset className="flex flex-col gap-1 text-sm">
              <legend>苗の種類</legend>
              <div className="flex gap-4">
                {MAT_ORIGIN_TYPES.map((t) => (
                  <label key={t} className="flex min-h-12 items-center gap-2">
                    <input
                      type="radio"
                      name="originType"
                      value={t}
                      checked={form.originType === t}
                      onChange={() => setForm({ ...form, originType: t })}
                      className="h-5 w-5"
                    />
                    {MAT_ORIGIN_LABELS[t]}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex gap-3">
              <button type="submit" className={secondaryButtonClass} disabled={saving}>
                プレビュー
              </button>
              {mode === "preview" && (
                <button
                  type="button"
                  className={primaryButtonClass}
                  onClick={confirm}
                  disabled={saving}
                  data-testid="place-confirm"
                >
                  {saving ? "保存中…" : `確定（${preview?.length ?? 0} 株）`}
                </button>
              )}
            </div>
          </form>
        )}

        {mode !== "idle" && (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={cancelPlacement}
            disabled={saving}
          >
            やめる
          </button>
        )}

        {error && (
          <p role="alert" data-testid="place-error" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        {notice && (
          <p data-testid="place-notice" className="text-sm text-green-700 dark:text-green-400">
            {notice}
          </p>
        )}
      </section>
    </div>
  );
}
