"use client";

import type { Map as MapLibreMap, MapMouseEvent, Marker } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import type { LatLng } from "@/lib/geo";
import { addMatMarkers, createFieldMap, makeGuideMarker, type MapMat } from "./field-map-core";

// 圃場の地図で 1 点を選ぶ（株分け 2-2 の転出先の位置）。圃場マップの「1株追加」（1-4）と同じ地図・株の点・目印
// （field-map-core.ts）を使い、地図をタップした位置を onPick で返す。選んだ位置は value として目印（guide-marker-single）で出す。
// 株の点をタップしても株の詳細には移らない（地図のタップとして扱う。空いているかの判定は呼び出し側）。
// maplibre-gl はブラウザでしか動かないので、読み込む側は next/dynamic の ssr: false で読む。
export function PointPickerMap({
  center,
  mats,
  value,
  onPick,
}: {
  center: LatLng;
  mats: MapMat[];
  value: LatLng | null;
  onPick: (p: LatLng) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const onPickRef = useRef(onPick);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

  // 地図の初期化（圃場が変わったら作り直す。呼び出し側が key で作り直してもよい）
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const map = createFieldMap(container, { center, mats, onReady: () => setMapReady(true) });
    map.on("click", (e: MapMouseEvent) => onPickRef.current({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      setMapReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 圃場（中心）が変わったときだけ作り直す
  }, [center.lat, center.lng]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers: Marker[] = addMatMarkers(map, mats);
    return () => {
      for (const m of markers) m.remove();
    };
  }, [mats, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !value) return;
    const marker = makeGuideMarker(map, value, "bg-amber-400", "single");
    return () => {
      marker.remove();
    };
  }, [value, mapReady]);

  return (
    <div
      ref={containerRef}
      data-testid="field-map"
      data-map-ready={mapReady ? "true" : "false"}
      className="h-[50vh] min-h-72 w-full bg-muted"
      aria-label="圃場マップ（位置を選ぶ）"
    />
  );
}
