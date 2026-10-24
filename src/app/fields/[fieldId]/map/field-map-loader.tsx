"use client";

import dynamic from "next/dynamic";
import type { FieldMapProps } from "./field-map";

// MapLibre はブラウザでしか動かないので SSR を切る（ssr: false は Client Component の中でだけ使える）
const FieldMap = dynamic(() => import("./field-map").then((m) => m.FieldMap), {
  ssr: false,
  loading: () => (
    <p className="px-4 py-6 text-muted-foreground" data-testid="map-loading">
      地図を読み込み中…
    </p>
  ),
});

export function FieldMapLoader(props: FieldMapProps) {
  return <FieldMap {...props} />;
}
