import { describe, expect, it } from "vitest";
import {
  fitWithinLongEdge,
  gpsToDecimal,
  latLngFromExif,
  parseExifDateTime,
  parseLatLng,
  parsePhotoKind,
  parseTakenAtIso,
  photoStoragePath,
  resolveTakenAt,
} from "./photos";

describe("photoStoragePath", () => {
  it("{organization_id}/{target_type}/{target_id}/{photo_id}.jpg の形にする", () => {
    expect(
      photoStoragePath({
        organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        targetType: "stem",
        targetId: "11111111-1111-4111-8111-111111111111",
        photoId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/stem/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg",
    );
  });
});

describe("fitWithinLongEdge（長辺 2048px に縮小）", () => {
  it("長辺が上限以下なら変えない", () => {
    expect(fitWithinLongEdge({ width: 2048, height: 1536 })).toEqual({ width: 2048, height: 1536, scaled: false });
    expect(fitWithinLongEdge({ width: 640, height: 480 })).toEqual({ width: 640, height: 480, scaled: false });
  });
  it("横長は幅を 2048 にして比率を保つ", () => {
    expect(fitWithinLongEdge({ width: 4032, height: 3024 })).toEqual({ width: 2048, height: 1536, scaled: true });
  });
  it("縦長は高さを 2048 にして比率を保つ", () => {
    expect(fitWithinLongEdge({ width: 3024, height: 4032 })).toEqual({ width: 1536, height: 2048, scaled: true });
  });
  it("端数は四捨五入し、1px を下回らない", () => {
    expect(fitWithinLongEdge({ width: 4000, height: 3 })).toEqual({ width: 2048, height: 2, scaled: true });
    expect(fitWithinLongEdge({ width: 10000, height: 1 })).toEqual({ width: 2048, height: 1, scaled: true });
  });
  it("上限を変えられる", () => {
    expect(fitWithinLongEdge({ width: 4032, height: 3024 }, 1024)).toEqual({ width: 1024, height: 768, scaled: true });
  });
  it("0 や負の大きさは例外", () => {
    expect(() => fitWithinLongEdge({ width: 0, height: 100 })).toThrow();
    expect(() => fitWithinLongEdge({ width: 100, height: -1 })).toThrow();
  });
});

describe("parseExifDateTime", () => {
  it("タイムゾーンなしの EXIF 文字列は端末のローカル時刻として読む", () => {
    const d = parseExifDateTime("2026:10:20 09:15:30");
    expect(d).toEqual(new Date(2026, 9, 20, 9, 15, 30));
  });
  it("OffsetTimeOriginal があればそれを使う", () => {
    expect(parseExifDateTime("2026:10:20 09:15:30", "+09:00")?.toISOString()).toBe("2026-10-20T00:15:30.000Z");
    expect(parseExifDateTime("2026:10:20 09:15:30", "-03:30")?.toISOString()).toBe("2026-10-20T12:45:30.000Z");
  });
  it("Date ならそのまま", () => {
    const d = new Date("2026-01-02T03:04:05Z");
    expect(parseExifDateTime(d)).toBe(d);
    expect(parseExifDateTime(new Date("invalid"))).toBeNull();
  });
  it("未設定（0000:00:00）・不正・空は null", () => {
    expect(parseExifDateTime("0000:00:00 00:00:00")).toBeNull();
    expect(parseExifDateTime("2026:02:30 10:00:00")).toBeNull();
    expect(parseExifDateTime("2026-10-20 09:15:30")).toBeNull();
    expect(parseExifDateTime("")).toBeNull();
    expect(parseExifDateTime(undefined)).toBeNull();
    expect(parseExifDateTime(12345)).toBeNull();
  });
});

describe("resolveTakenAt（EXIF が読めなければ現在時刻）", () => {
  const now = new Date("2026-10-22T10:00:00Z");
  it("EXIF の日時があればそれを使う", () => {
    const exif = new Date("2026-10-20T00:15:30Z");
    expect(resolveTakenAt(exif, now)).toEqual({ takenAt: exif, source: "exif" });
  });
  it("EXIF がなければ現在時刻", () => {
    expect(resolveTakenAt(null, now)).toEqual({ takenAt: now, source: "now" });
    expect(resolveTakenAt(undefined, now)).toEqual({ takenAt: now, source: "now" });
  });
  it("1 日以上未来の EXIF（時計が狂っている）は使わず現在時刻", () => {
    expect(resolveTakenAt(new Date("2026-10-24T10:00:01Z"), now)).toEqual({ takenAt: now, source: "now" });
    // 1 日以内の未来は許容（タイムゾーンの取り違え程度）
    const slight = new Date("2026-10-23T09:00:00Z");
    expect(resolveTakenAt(slight, now)).toEqual({ takenAt: slight, source: "exif" });
  });
  it("不正な Date は現在時刻", () => {
    expect(resolveTakenAt(new Date("invalid"), now)).toEqual({ takenAt: now, source: "now" });
  });
});

describe("gpsToDecimal / latLngFromExif", () => {
  it("度分秒と半球記号を 10 進にする（S / W は負）", () => {
    expect(gpsToDecimal([26, 30, 0], "N")).toBeCloseTo(26.5, 9);
    expect(gpsToDecimal([127, 54, 0], "E")).toBeCloseTo(127.9, 9);
    expect(gpsToDecimal([26, 30, 0], "S")).toBeCloseTo(-26.5, 9);
    expect(gpsToDecimal([127, 54, 0], "W")).toBeCloseTo(-127.9, 9);
  });
  it("分数（[分子, 分母]）の形でも読める", () => {
    expect(gpsToDecimal([[26, 1], [30, 1], [0, 1]], "N")).toBeCloseTo(26.5, 9);
    expect(gpsToDecimal([[26, 1], [30, 1], [0, 0]], "N")).toBeNull();
  });
  it("欠けていれば null", () => {
    expect(gpsToDecimal(undefined, "N")).toBeNull();
    expect(gpsToDecimal([], "N")).toBeNull();
    expect(gpsToDecimal(["a", 1, 2], "N")).toBeNull();
  });
  it("latLngFromExif は両方そろったときだけ返す。(0, 0) と範囲外は null", () => {
    expect(
      latLngFromExif({ GPSLatitude: [26, 30, 0], GPSLatitudeRef: "N", GPSLongitude: [127, 54, 0], GPSLongitudeRef: "E" }),
    ).toEqual({ lat: 26.5, lng: 127.9 });
    expect(latLngFromExif({ GPSLatitude: [26, 30, 0], GPSLatitudeRef: "N" })).toBeNull();
    expect(latLngFromExif({ GPSLatitude: [0, 0, 0], GPSLatitudeRef: "N", GPSLongitude: [0, 0, 0], GPSLongitudeRef: "E" })).toBeNull();
    expect(latLngFromExif({ GPSLatitude: [91, 0, 0], GPSLatitudeRef: "N", GPSLongitude: [10, 0, 0], GPSLongitudeRef: "E" })).toBeNull();
    expect(latLngFromExif(null)).toBeNull();
  });
});

describe("parsePhotoKind / parseLatLng / parseTakenAtIso（Server Action の入力）", () => {
  it("種類は既知の値だけ。空・未知は既定の side", () => {
    expect(parsePhotoKind("bud")).toBe("bud");
    expect(parsePhotoKind("damage")).toBe("damage");
    expect(parsePhotoKind("")).toBe("side");
    expect(parsePhotoKind("selfie")).toBe("side");
    expect(parsePhotoKind(null)).toBe("side");
  });
  it("緯度経度は両方そろって範囲内のときだけ", () => {
    expect(parseLatLng("26.5", "127.9")).toEqual({ lat: 26.5, lng: 127.9 });
    expect(parseLatLng("", "")).toBeNull();
    expect(parseLatLng("26.5", "")).toBeNull();
    expect(parseLatLng("abc", "127.9")).toBeNull();
    expect(parseLatLng("95", "127.9")).toBeNull();
  });
  it("撮影日時は ISO 文字列。不正・空は null", () => {
    expect(parseTakenAtIso("2026-10-20T00:15:30.000Z")?.toISOString()).toBe("2026-10-20T00:15:30.000Z");
    expect(parseTakenAtIso("")).toBeNull();
    expect(parseTakenAtIso("not a date")).toBeNull();
  });
});
