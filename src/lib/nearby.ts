// 現在地から近い株（2-8、画面 2、UC-2）の純粋ロジック。UI・ブラウザ API に依存しない。
//
// - 近い株: その圃場の撤去していない株を、現在地からの距離（src/lib/geo.ts の distanceM）の近い順に並べ、上位 3 件。
//   同じ距離（cm 単位で同じ）なら株コード順（数字は数値として比べる）
// - 精度の注意: Geolocation の accuracy（m）が 10 m を超えたら注意を出す（候補は 3 株のまま）
// - 位置情報が使えない理由: 拒否・取得できない・タイムアウト・非対応の日本語の文言
// - 代表の茎の状態: 株ごとの「最も進んだ茎」の状態（候補の行に出す）
// 現在地は保存しない（DB にも localStorage にも）。ここは受け取った位置で計算するだけ。
import { distanceM, type LatLng } from "./geo";
import { stemStatusLabel } from "./stems/status";

export const NEARBY_LIMIT = 3;
// これを超える accuracy（m）は「誤差が大きい」
export const ACCURACY_WARN_M = 10;

// navigator.geolocation.getCurrentPosition に渡すオプション（押したときだけ取得。watchPosition は使わない）
export const GEOLOCATION_OPTIONS = { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 } as const;

export type NearbyCandidate = {
  id: string;
  code: string;
  lat: number;
  lng: number;
  // mats.status。撤去済み（removed）は候補にしない。省略は撤去していない扱い
  status?: string;
};

export type NearbyResult<T extends NearbyCandidate> = T & { distanceM: number };

function compareCode(a: string, b: string): number {
  return a.localeCompare(b, "ja", { numeric: true });
}

// 距離は cm 単位に丸めて比べる（浮動小数の誤差で同じ距離の株の順番が揺れないように。同じなら株コード順）
const toCm = (m: number) => Math.round(m * 100);

// 現在地から近い順に limit 件（既定 3）。元の配列は変えない
export function nearestMats<T extends NearbyCandidate>(
  origin: LatLng,
  mats: readonly T[],
  limit: number = NEARBY_LIMIT,
): NearbyResult<T>[] {
  return mats
    .filter((m) => m.status !== "removed")
    .map((m) => ({ ...m, distanceM: distanceM(origin, m) }))
    .sort(
      (a, b) => toCm(a.distanceM) - toCm(b.distanceM) || compareCode(a.code, b.code) || a.id.localeCompare(b.id),
    )
    .slice(0, Math.max(0, limit));
}

// 距離の表示（「12 m」）。整数の m に丸める
export function formatDistance(m: number): string {
  return `${Math.round(m)} m`;
}

export function isAccuracyLow(accuracyM: number): boolean {
  return accuracyM > ACCURACY_WARN_M;
}

// 誤差が大きいときの注意。大きくなければ null
export function accuracyWarning(accuracyM: number): string | null {
  if (!isAccuracyLow(accuracyM)) return null;
  return `位置の誤差が大きい（± ${Math.round(accuracyM)} m）。候補の順番は目安です`;
}

export type GeolocationErrorKind = "denied" | "unavailable" | "timeout" | "unsupported";

// GeolocationPositionError.code（1 = PERMISSION_DENIED、2 = POSITION_UNAVAILABLE、3 = TIMEOUT）から種類へ
export function geolocationErrorKind(code: number): GeolocationErrorKind {
  if (code === 1) return "denied";
  if (code === 3) return "timeout";
  return "unavailable";
}

export function geolocationErrorMessage(kind: GeolocationErrorKind): string {
  switch (kind) {
    case "denied":
      return "位置情報の利用が許可されていません。設定アプリ → Safari（または ホーム画面のアプリ）→ 位置情報 で許可してください。地図と株のタップはこのまま使えます";
    case "unavailable":
      return "現在地を取得できませんでした（GPS の電波が届かない可能性があります）。空の見える場所でもう一度お試しください。地図と株のタップはこのまま使えます";
    case "timeout":
      return "現在地の取得に時間がかかりすぎました。もう一度「現在地」を押してください。地図と株のタップはこのまま使えます";
    case "unsupported":
      return "この端末・ブラウザは位置情報に対応していません。地図と株のタップはこのまま使えます";
  }
}

// 代表の茎の比較: 出蕾済み → 栽培中 → 吸芽 → 収穫済み → それ以外。同じなら世代の若い順、started_at の早い順
const STATUS_RANK: Record<string, number> = { flowered: 0, active: 1, sucker: 2, harvested: 3 };

export type StemSummary = { status: string; generation: number; started_at: string };

export function representativeStemStatus(stems: readonly StemSummary[]): string | null {
  if (stems.length === 0) return null;
  const rank = (s: StemSummary) => STATUS_RANK[s.status] ?? 9;
  const rep = [...stems].sort(
    (a, b) => rank(a) - rank(b) || a.generation - b.generation || a.started_at.localeCompare(b.started_at),
  )[0];
  return rep.status;
}

// 候補の行に出す茎の状態（茎がなければ「茎なし」）
export function nearbyStemLabel(status: string | null | undefined): string {
  return status ? stemStatusLabel(status) : "茎なし";
}
