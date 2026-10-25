import { describe, expect, it } from "vitest";
import { distanceM, offsetLatLng } from "./geo";
import {
  accuracyWarning,
  formatDistance,
  GEOLOCATION_OPTIONS,
  geolocationErrorKind,
  geolocationErrorMessage,
  isAccuracyLow,
  nearbyStemLabel,
  nearestMats,
  representativeStemStatus,
} from "./nearby";

const here = { lat: 26.5, lng: 127.9 };
const at = (code: string, bearing: number, m: number, status?: string) => ({
  id: `id-${code}`,
  code,
  ...offsetLatLng(here, bearing, m),
  ...(status ? { status } : {}),
});

describe("nearestMats", () => {
  it("近い順に 3 件と距離（m）", () => {
    const mats = [at("A-001", 0, 20), at("A-002", 90, 5), at("A-003", 180, 12), at("A-004", 270, 40), at("A-005", 45, 8)];
    const result = nearestMats(here, mats);
    expect(result.map((m) => m.code)).toEqual(["A-002", "A-005", "A-003"]);
    expect(result[0].distanceM).toBeCloseTo(5, 3);
    expect(result[1].distanceM).toBeCloseTo(8, 3);
    expect(result[2].distanceM).toBeCloseTo(12, 3);
    expect(result[0].distanceM).toBeCloseTo(distanceM(here, mats[1]), 9);
  });

  it("同じ距離なら株コード順（数字は数値として比べる）", () => {
    const mats = [at("A-010", 0, 10), at("A-002", 90, 10), at("A-009", 180, 10), at("A-001", 270, 30)];
    expect(nearestMats(here, mats).map((m) => m.code)).toEqual(["A-002", "A-009", "A-010"]);
  });

  it("撤去済みの株は候補にしない", () => {
    const mats = [at("A-001", 0, 1, "removed"), at("A-002", 0, 5, "active"), at("A-003", 0, 9)];
    expect(nearestMats(here, mats).map((m) => m.code)).toEqual(["A-002", "A-003"]);
  });

  it("3 株より少なければあるだけ、0 株なら空", () => {
    expect(nearestMats(here, [at("A-001", 0, 3)])).toHaveLength(1);
    expect(nearestMats(here, [])).toEqual([]);
  });

  it("limit を変えられる。元の配列は変えない", () => {
    const mats = [at("A-002", 0, 20), at("A-001", 0, 10)];
    const copy = [...mats];
    expect(nearestMats(here, mats, 1).map((m) => m.code)).toEqual(["A-001"]);
    expect(mats).toEqual(copy);
  });

  it("元の項目（状態など）を保ったまま返す", () => {
    const result = nearestMats(here, [{ ...at("A-001", 0, 3), stemStatus: "flowered" }]);
    expect(result[0].stemStatus).toBe("flowered");
  });
});

describe("formatDistance", () => {
  it("整数の m に丸める", () => {
    expect(formatDistance(12.4)).toBe("12 m");
    expect(formatDistance(12.5)).toBe("13 m");
    expect(formatDistance(0.2)).toBe("0 m");
  });
});

describe("精度の注意", () => {
  it("10 m を超えたら注意（10 m ちょうどは出さない）", () => {
    expect(isAccuracyLow(10)).toBe(false);
    expect(isAccuracyLow(10.1)).toBe(true);
    expect(accuracyWarning(5)).toBeNull();
    expect(accuracyWarning(10)).toBeNull();
    expect(accuracyWarning(30)).toBe("位置の誤差が大きい（± 30 m）。候補の順番は目安です");
    expect(accuracyWarning(24.6)).toContain("± 25 m");
  });
});

describe("位置情報のエラー", () => {
  it("コードから種類へ（1 拒否、2 取得できない、3 タイムアウト）", () => {
    expect(geolocationErrorKind(1)).toBe("denied");
    expect(geolocationErrorKind(2)).toBe("unavailable");
    expect(geolocationErrorKind(3)).toBe("timeout");
    expect(geolocationErrorKind(99)).toBe("unavailable");
  });

  it("拒否は設定アプリでの許可の案内を含む", () => {
    expect(geolocationErrorMessage("denied")).toContain("設定アプリ → Safari（または ホーム画面のアプリ）→ 位置情報 で許可してください");
  });

  it("どの理由も日本語で、地図はそのまま使えることを伝える", () => {
    for (const kind of ["denied", "unavailable", "timeout", "unsupported"] as const) {
      expect(geolocationErrorMessage(kind)).toContain("地図と株のタップはこのまま使えます");
    }
    expect(geolocationErrorMessage("timeout")).toContain("時間がかかりすぎ");
    expect(geolocationErrorMessage("unsupported")).toContain("対応していません");
    expect(geolocationErrorMessage("unavailable")).toContain("取得できませんでした");
  });

  it("取得のオプションは高精度・10 秒・30 秒以内のキャッシュ", () => {
    expect(GEOLOCATION_OPTIONS).toEqual({ enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 });
  });
});

describe("representativeStemStatus", () => {
  it("茎がなければ null", () => {
    expect(representativeStemStatus([])).toBeNull();
  });

  it("出蕾済み → 栽培中 → 吸芽 → 収穫済み → それ以外の順", () => {
    const s = (status: string, generation = 1, started_at = "2026-01-01") => ({ status, generation, started_at });
    expect(representativeStemStatus([s("active"), s("flowered", 2)])).toBe("flowered");
    expect(representativeStemStatus([s("sucker"), s("active", 2)])).toBe("active");
    expect(representativeStemStatus([s("harvested"), s("sucker", 2)])).toBe("sucker");
    expect(representativeStemStatus([s("lost"), s("harvested")])).toBe("harvested");
    expect(representativeStemStatus([s("removed")])).toBe("removed");
  });

  it("nearbyStemLabel は茎がなければ「茎なし」", () => {
    expect(nearbyStemLabel(null)).toBe("茎なし");
    expect(nearbyStemLabel("flowered")).toBe("出蕾済み");
    expect(nearbyStemLabel("active")).toBe("栽培中");
  });
});
