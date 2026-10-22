// 写真（1-7）の純粋ロジック。UI・ブラウザ API・DB に依存しない。
//
// - 保存先のパスは `{organization_id}/{target_type}/{target_id}/{photo_id}.jpg`（architecture.md 4 章）
// - 端末側で長辺 2048px に縮小してから送る。縮小後のサイズ計算はここで行う
// - 撮影日時は EXIF の DateTimeOriginal。読めなければ現在時刻（data-model.md photos.taken_at）
// - 撮影位置は EXIF の GPS。度分秒 + 半球記号を 10 進に変換する

export const MAX_PHOTO_LONG_EDGE_PX = 2048;

export const PHOTO_KINDS = ["side", "bud", "bunch", "damage", "other"] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];
export const DEFAULT_PHOTO_KIND: PhotoKind = "side";

export const PHOTO_KIND_LABELS: Record<PhotoKind, string> = {
  side: "横から",
  bud: "蕾",
  bunch: "果房",
  damage: "被害",
  other: "その他",
};

export function photoKindLabel(kind: string): string {
  return (PHOTO_KIND_LABELS as Record<string, string>)[kind] ?? kind;
}

// 種類の入力。未知の値・空は既定（横から）
export function parsePhotoKind(input: string | null | undefined): PhotoKind {
  const s = (input ?? "").trim();
  return (PHOTO_KINDS as readonly string[]).includes(s) ? (s as PhotoKind) : DEFAULT_PHOTO_KIND;
}

export type PhotoTargetType = "stem" | "mat" | "field";

// Storage のパス。photo_id は `photos.id` と同じ uuid（アップロード前に採番する）
export function photoStoragePath(args: {
  organizationId: string;
  targetType: PhotoTargetType;
  targetId: string;
  photoId: string;
}): string {
  return `${args.organizationId}/${args.targetType}/${args.targetId}/${args.photoId}.jpg`;
}

// --- 縮小 --------------------------------------------------------------------

export type ImageSize = { width: number; height: number };

// 長辺が maxLongEdge を超えるときだけ、比率を保って縮小する。小さい画像は拡大しない。
// 結果は 1px 以上の整数（四捨五入）
export function fitWithinLongEdge(size: ImageSize, maxLongEdge = MAX_PHOTO_LONG_EDGE_PX): ImageSize & { scaled: boolean } {
  const { width, height } = size;
  if (!(width > 0) || !(height > 0)) throw new Error(`画像の大きさが不正です（${width}x${height}）`);
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width: Math.round(width), height: Math.round(height), scaled: false };
  const ratio = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

// --- 撮影日時 ----------------------------------------------------------------

// EXIF の日時文字列 "YYYY:MM:DD HH:MM:SS"（タイムゾーンなし）を Date にする。
// offset（OffsetTimeOriginal、例 "+09:00"）があればそれを使い、なければ端末のローカル時刻とみなす。
// 読めない・不正な値は null
export function parseExifDateTime(raw: unknown, offset?: unknown): Date | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  // 未設定のカメラは "0000:00:00 00:00:00" を書く
  if (year === 0) return null;

  const tz = typeof offset === "string" ? offset.trim().match(/^([+-])(\d{2}):?(\d{2})$/) : null;
  let date: Date;
  if (tz) {
    const sign = tz[1] === "-" ? -1 : 1;
    const offsetMinutes = sign * (Number(tz[2]) * 60 + Number(tz[3]));
    date = new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000);
  } else {
    date = new Date(year, month - 1, day, hour, minute, second);
  }
  if (Number.isNaN(date.getTime())) return null;
  // 2 月 30 日のような繰り上がりは不正とみなす（UTC で組んだときは日付を戻してから比べる）
  const check = tz ? new Date(date.getTime() + Number(tz[1] === "-" ? -1 : 1) * (Number(tz[2]) * 60 + Number(tz[3])) * 60_000) : date;
  const sameDay = tz ? check.getUTCDate() === day : check.getDate() === day;
  return sameDay ? date : null;
}

export type TakenAt = { takenAt: Date; source: "exif" | "now" };

// 撮影日時の決定。EXIF が読めて妥当（1 日以上未来でない）ならそれ、そうでなければ現在時刻
export function resolveTakenAt(exifDate: Date | null | undefined, now: Date = new Date()): TakenAt {
  if (exifDate && !Number.isNaN(exifDate.getTime()) && exifDate.getTime() <= now.getTime() + 24 * 60 * 60_000) {
    return { takenAt: exifDate, source: "exif" };
  }
  return { takenAt: now, source: "now" };
}

// --- 撮影位置 ----------------------------------------------------------------

type Rational = number | readonly [number, number];

function toNumber(r: unknown): number | null {
  if (typeof r === "number") return Number.isFinite(r) ? r : null;
  if (Array.isArray(r) && r.length === 2 && typeof r[0] === "number" && typeof r[1] === "number" && r[1] !== 0) {
    return r[0] / r[1];
  }
  return null;
}

// EXIF の GPS（度・分・秒の配列と N/S/E/W）を 10 進の度にする。欠けていれば null
export function gpsToDecimal(dms: unknown, ref: unknown): number | null {
  if (!Array.isArray(dms) || dms.length === 0) return null;
  const parts = (dms as Rational[]).map(toNumber);
  if (parts.some((p) => p === null)) return null;
  const [d = 0, m = 0, s = 0] = parts as number[];
  let value = d + m / 60 + s / 3600;
  const r = typeof ref === "string" ? ref.trim().toUpperCase() : "";
  if (r === "S" || r === "W") value = -value;
  return value;
}

export type LatLng = { lat: number; lng: number };

// EXIF から緯度経度を取り出す。どちらかが読めない、または範囲外なら null
export function latLngFromExif(exif: Record<string, unknown> | null | undefined): LatLng | null {
  if (!exif) return null;
  const lat = gpsToDecimal(exif.GPSLatitude, exif.GPSLatitudeRef);
  const lng = gpsToDecimal(exif.GPSLongitude, exif.GPSLongitudeRef);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // (0, 0) は未取得のカメラが書く値
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

// Server Action に渡した文字列の緯度経度を戻す。空・不正は null（写真は位置なしで保存できる）
export function parseLatLng(latInput: string | null | undefined, lngInput: string | null | undefined): LatLng | null {
  const lat = Number((latInput ?? "").trim());
  const lng = Number((lngInput ?? "").trim());
  if ((latInput ?? "").trim() === "" || (lngInput ?? "").trim() === "") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// Server Action に渡した ISO 文字列の撮影日時を戻す。不正なら null
export function parseTakenAtIso(input: string | null | undefined): Date | null {
  const s = (input ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// 写真の記録 Server Action の戻り値（useActionState の state）
export type PhotoRecordState = { error: string | null; succeeded: number };
export const INITIAL_PHOTO_RECORD_STATE: PhotoRecordState = { error: null, succeeded: 0 };

// 署名付き URL の有効期限（秒）。履歴の表示のたびにサーバーで作り直す
export const PHOTO_SIGNED_URL_TTL_SEC = 60 * 60;
