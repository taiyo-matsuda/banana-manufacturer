// 現在地の取得（2-8）。navigator.geolocation を直接呼ぶのはここだけ。
// 押したときに 1 回だけ getCurrentPosition で取る（watchPosition で追跡しない）。結果は保存しない。
// オプション・エラーの種類と文言は src/lib/nearby.ts（純粋関数・単体テスト）。
import { GEOLOCATION_OPTIONS, geolocationErrorKind, type GeolocationErrorKind } from "@/lib/nearby";

export type CurrentPosition = { lat: number; lng: number; accuracyM: number };

export type CurrentPositionResult =
  | { ok: true; position: CurrentPosition }
  | { ok: false; kind: GeolocationErrorKind };

export function getCurrentPosition(): Promise<CurrentPositionResult> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator) || !navigator.geolocation) {
    return Promise.resolve({ ok: false, kind: "unsupported" });
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          ok: true,
          position: { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy },
        }),
      (e) => resolve({ ok: false, kind: geolocationErrorKind(e.code) }),
      GEOLOCATION_OPTIONS,
    );
  });
}
