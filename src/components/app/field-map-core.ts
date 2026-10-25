"use client";

// 圃場の地図（MapLibre ＋ 地理院タイルの空中写真）の共通部品。圃場マップ（1-3 / 1-4、fields/[fieldId]/map/field-map.tsx）と
// 株分けの位置の指定（2-2、point-picker-map.tsx）で同じ地図・同じ株の点・同じ目印を使う。点のドラッグ（attachPointerDrag）は
// 格子配置のプレビュー（1-3）と「位置を直す」モード（2-3）で共通。
// ブラウザでしか動かない（maplibre-gl）。読み込む側は next/dynamic の ssr: false で読む。
import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LatLng } from "@/lib/geo";

// 地理院タイル 空中写真（最大ズーム 18。それ以上は拡大表示）
const GSI_PHOTO_TILES = "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg";
const GSI_ATTRIBUTION =
  '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">地理院タイル（国土地理院）</a>';
export const INITIAL_ZOOM = 18;
export const MAX_ZOOM = 22;

// MapLibre の Web Worker。バンドラ経由では既定の場所（import.meta.url の隣）に無いので、
// scripts/copy-maplibre-worker.mjs が public/ に置いたものを使う
const MAPLIBRE_WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";
if (typeof window !== "undefined") setWorkerUrl(MAPLIBRE_WORKER_URL);

export type MapMat = { id: string; code: string; lat: number; lng: number };

// 「位置を直す」モード（2-3）で動かした株の点の見た目: 黄色の点に濃い輪郭（data-moved="true"）。
// 動かしていない株は通常の緑の点。色は地図上の DOM なので従来どおり直書き（CLAUDE.md の例外）
const MAT_DOT_CLASS = "h-3.5 w-3.5 rounded-full border-2 border-white bg-green-500 shadow";
const MOVED_MAT_DOT_CLASS = "h-4 w-4 rounded-full border-2 border-black bg-amber-400 shadow ring-2 ring-amber-200";

export function setLatLngAttrs(el: HTMLElement, p: LatLng) {
  el.dataset.lat = String(p.lat);
  el.dataset.lng = String(p.lng);
}

export function makeDot(className: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  return el;
}

// タップできる点（株・プレビュー）: 見た目の点は小さいまま、透明な 44px の当たり判定で包む（UX-1 完了条件 6）。
// data-* やイベントは外側（当たり判定）に付ける。MapLibre の Marker は要素の中心を座標に合わせるので位置は変わらない
export function makeTapTarget(dotClassName: string, extraClassName = ""): HTMLDivElement {
  const el = makeDot(`flex size-11 items-center justify-center ${extraClassName}`);
  el.appendChild(makeDot(`pointer-events-none ${dotClassName}`));
  return el;
}

// 選んだ点の目印（配置の 1 点目・2 点目、1株追加・株分けの位置）。data-testid は guide-marker-{kind}
export function makeGuideMarker(map: MapLibreMap, p: LatLng, color: string, kind: string): Marker {
  const el = makeDot(`h-3 w-3 rounded-full border-2 border-white shadow ${color}`);
  el.dataset.testid = `guide-marker-${kind}`;
  setLatLngAttrs(el, p);
  return new Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(map);
}

// 圃場の地図を作る。株があれば株全体が見えて 1 株ずつタップできるズームにする
// （初期ズーム 18 では 3m 間隔の株がほぼ重なる）。style.load で onReady を呼ぶ
export function createFieldMap(
  container: HTMLElement,
  options: { center: LatLng; mats: readonly LatLng[]; onReady: () => void },
): MapLibreMap {
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
    center: [options.center.lng, options.center.lat],
    zoom: INITIAL_ZOOM,
    maxZoom: MAX_ZOOM,
    // 出典は常時表示（compact にしない）
    attributionControl: { compact: false },
  });
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  map.on("style.load", options.onReady);
  if (options.mats.length > 0) {
    const bounds = new LngLatBounds();
    for (const m of options.mats) bounds.extend([m.lng, m.lat]);
    map.fitBounds(bounds, { padding: 60, maxZoom: 21, duration: 0 });
  }
  return map;
}

// 既存の株を点で表示する（色分けは 1-5 以降。いまは単色）。data-testid="mat-marker"、data-mat-id、data-code。
// タップの扱い（株の詳細へ / 地図のタップとして扱う）は呼び出し側がコンテナで受ける
export function addMatMarkers(map: MapLibreMap, mats: readonly MapMat[]): Marker[] {
  return mats.map((mat) => {
    const el = makeTapTarget(MAT_DOT_CLASS, "cursor-pointer");
    el.dataset.testid = "mat-marker";
    el.setAttribute("data-mat-id", `${mat.id}`);
    el.dataset.code = mat.code;
    el.title = mat.code;
    el.role = "link";
    el.ariaLabel = `株 ${mat.code}`;
    setLatLngAttrs(el, mat);
    return new Marker({ element: el }).setLngLat([mat.lng, mat.lat]).addTo(map);
  });
}

// 点のドラッグ（Pointer Events で自前実装。マウスとタッチの両方で同じ動き）。格子配置のプレビュー（1-3）と
// 「位置を直す」モードの株の点（2-3）で共通。ポインタを押した位置と点の位置のずれを保ち、点が指に飛びつかないようにする。
// ドラッグ中は地図のパン・タップに伝えない。onEnd は離したときの位置（動かしていなくても呼ぶ）。
// 戻り値はリスナーを外す関数（モードを抜けたらドラッグできないようにする）
export function attachPointerDrag(
  map: MapLibreMap,
  marker: Marker,
  el: HTMLElement,
  onEnd?: (p: LatLng) => void,
): () => void {
  let dragging = false;
  let dx = 0;
  let dy = 0;

  const toMapPoint = (ev: PointerEvent) => {
    const rect = map.getContainer().getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  };

  const down = (ev: PointerEvent) => {
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
  };
  const move = (ev: PointerEvent) => {
    if (!dragging) return;
    ev.preventDefault();
    const p = toMapPoint(ev);
    const ll = map.unproject([p.x + dx, p.y + dy]);
    marker.setLngLat(ll);
    setLatLngAttrs(el, { lat: ll.lat, lng: ll.lng });
  };
  const end = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("cursor-grabbing");
    if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    const ll = marker.getLngLat();
    onEnd?.({ lat: ll.lat, lng: ll.lng });
  };
  // 地図のパン・タップ（mousedown / touchstart）に伝えない
  const stopMouse = (ev: MouseEvent) => ev.stopPropagation();
  const stopTouch = (ev: TouchEvent) => ev.stopPropagation();

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("mousedown", stopMouse);
  el.addEventListener("touchstart", stopTouch, { passive: true });
  const prevTouchAction = el.style.touchAction;
  el.style.touchAction = "none";

  return () => {
    el.removeEventListener("pointerdown", down);
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", end);
    el.removeEventListener("pointercancel", end);
    el.removeEventListener("mousedown", stopMouse);
    el.removeEventListener("touchstart", stopTouch);
    el.style.touchAction = prevTouchAction;
  };
}

// 動かした株の点の見た目を切り替える（上の MOVED_MAT_DOT_CLASS）
export function markMatMoved(el: HTMLElement, moved: boolean) {
  const dot = el.firstElementChild as HTMLElement | null;
  if (dot) dot.className = `pointer-events-none ${moved ? MOVED_MAT_DOT_CLASS : MAT_DOT_CLASS}`;
  if (moved) el.dataset.moved = "true";
  else delete el.dataset.moved;
}
