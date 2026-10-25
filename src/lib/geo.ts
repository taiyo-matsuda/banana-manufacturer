// 株の格子生成と距離計算。UI に依存しない純粋関数。
// 圃場は数十 m 四方なので、緯度経度を平面に近似する（1 度あたりの m を緯度で補正する簡易式）。

export type LatLng = { lat: number; lng: number };

// 地球の平均半径（m）。距離とオフセットの両方で同じ値を使い、整合させる
const EARTH_RADIUS_M = 6371008.8;
const METERS_PER_DEG_LAT = (2 * Math.PI * EARTH_RADIUS_M) / 360;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

// 緯度 lat における 1 度あたりの m（緯度方向・経度方向）
export function metersPerDegree(lat: number): { lat: number; lng: number } {
  return { lat: METERS_PER_DEG_LAT, lng: METERS_PER_DEG_LAT * Math.cos(toRad(lat)) };
}

// 2 点間の距離（m）。haversine
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

// a から b への方位角（度）。北 = 0、東 = 90、時計回り、0 <= 結果 < 360。
// 2 点が同じなら 0（北）
export function bearingDeg(a: LatLng, b: LatLng): number {
  const mpd = metersPerDegree((a.lat + b.lat) / 2);
  const dx = (b.lng - a.lng) * mpd.lng; // 東向き m
  const dy = (b.lat - a.lat) * mpd.lat; // 北向き m
  if (dx === 0 && dy === 0) return 0;
  const deg = toDeg(Math.atan2(dx, dy));
  return (deg + 360) % 360;
}

// origin から方位角 bearing の方向へ distance（m）進んだ点
export function offsetLatLng(origin: LatLng, bearing: number, distance: number): LatLng {
  const mpd = metersPerDegree(origin.lat);
  const rad = toRad(bearing);
  return {
    lat: origin.lat + (distance * Math.cos(rad)) / mpd.lat,
    lng: origin.lng + (distance * Math.sin(rad)) / mpd.lng,
  };
}

export type GridSpec = {
  // 最初の株（列 0、本 0）の位置
  origin: LatLng;
  // 列に沿った方向（度）。1 点目から 2 点目への方位角
  bearing: number;
  // 株間（m）。列内の株の間隔と、列と列の間隔の両方に使う
  spacingM: number;
  // 列数（列方向と直交する方向に並ぶ数）
  rows: number;
  // 1 列の本数（列方向に並ぶ数）
  perRow: number;
};

export type GridPoint = LatLng & { row: number; index: number };

// 格子の各株の緯度経度を返す。順序は列ごと（row 0 の index 0..perRow-1、次に row 1 …）。
// 列と列の間隔は、列方向を時計回りに 90 度回した向きにとる
export function gridPoints(spec: GridSpec): GridPoint[] {
  const { origin, bearing, spacingM, rows, perRow } = spec;
  if (!Number.isInteger(rows) || rows < 1) throw new Error("rows は 1 以上の整数");
  if (!Number.isInteger(perRow) || perRow < 1) throw new Error("perRow は 1 以上の整数");
  if (!(spacingM > 0)) throw new Error("spacingM は正の数");

  const points: GridPoint[] = [];
  for (let row = 0; row < rows; row++) {
    const rowOrigin = offsetLatLng(origin, bearing + 90, row * spacingM);
    for (let index = 0; index < perRow; index++) {
      const p = offsetLatLng(rowOrigin, bearing, index * spacingM);
      points.push({ ...p, row, index });
    }
  }
  return points;
}

// 中心 center、半径 radiusM（m）の円を近似した多角形の頂点（閉じた輪: 最初と最後が同じ点）。
// 現在地の精度の円（2-8）に使う。steps は頂点の数（3 以上）
export function circlePolygon(center: LatLng, radiusM: number, steps = 64): LatLng[] {
  if (!Number.isInteger(steps) || steps < 3) throw new Error("steps は 3 以上の整数");
  if (!(radiusM >= 0)) throw new Error("radiusM は 0 以上");
  const ring: LatLng[] = [];
  for (let i = 0; i < steps; i++) ring.push(offsetLatLng(center, (360 * i) / steps, radiusM));
  ring.push(ring[0]);
  return ring;
}
