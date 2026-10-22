import { describe, expect, it } from "vitest";
import { bearingDeg, distanceM, gridPoints, metersPerDegree, offsetLatLng } from "./geo";

// 沖縄本島北部あたり
const origin = { lat: 26.5, lng: 127.9 };

describe("metersPerDegree", () => {
  it("緯度方向は約 111.2 km、経度方向は緯度で縮む", () => {
    const m = metersPerDegree(26.5);
    expect(m.lat).toBeCloseTo(111195, -1);
    expect(m.lng).toBeCloseTo(111195 * Math.cos((26.5 * Math.PI) / 180), -1);
  });
});

describe("distanceM", () => {
  it("同じ点なら 0", () => {
    expect(distanceM(origin, origin)).toBe(0);
  });

  it("緯度 1 度の差は約 111.2 km", () => {
    expect(distanceM(origin, { lat: 27.5, lng: 127.9 })).toBeCloseTo(111195, -2);
  });

  it("対称", () => {
    const b = { lat: 26.5003, lng: 127.9004 };
    expect(distanceM(origin, b)).toBeCloseTo(distanceM(b, origin), 9);
  });
});

describe("bearingDeg", () => {
  it("北は 0、東は 90、南は 180、西は 270", () => {
    expect(bearingDeg(origin, { lat: 26.6, lng: 127.9 })).toBeCloseTo(0, 6);
    expect(bearingDeg(origin, { lat: 26.5, lng: 128.0 })).toBeCloseTo(90, 6);
    expect(bearingDeg(origin, { lat: 26.4, lng: 127.9 })).toBeCloseTo(180, 6);
    expect(bearingDeg(origin, { lat: 26.5, lng: 127.8 })).toBeCloseTo(270, 6);
  });

  it("同じ点なら 0", () => {
    expect(bearingDeg(origin, origin)).toBe(0);
  });

  it("offsetLatLng で進んだ方向と一致する", () => {
    const b = offsetLatLng(origin, 37, 20);
    expect(bearingDeg(origin, b)).toBeCloseTo(37, 4);
  });
});

describe("offsetLatLng", () => {
  it("進んだ距離が指定どおり", () => {
    for (const bearing of [0, 45, 90, 200, 315]) {
      const p = offsetLatLng(origin, bearing, 3);
      expect(distanceM(origin, p)).toBeCloseTo(3, 3);
    }
  });

  it("距離 0 なら元の点", () => {
    expect(offsetLatLng(origin, 123, 0)).toEqual(origin);
  });
});

describe("gridPoints", () => {
  it("2 列 × 3 本・3m で 6 点、隣接点の距離が 3m ± 0.05m", () => {
    const pts = gridPoints({ origin, bearing: 60, spacingM: 3, rows: 2, perRow: 3 });
    expect(pts).toHaveLength(6);
    // 順序: row 0 の index 0..2、row 1 の index 0..2
    expect(pts.map((p) => [p.row, p.index])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
    ]);
    // 列内の隣接
    for (const row of [0, 1]) {
      for (let i = 0; i < 2; i++) {
        const d = distanceM(pts[row * 3 + i], pts[row * 3 + i + 1]);
        expect(Math.abs(d - 3)).toBeLessThanOrEqual(0.05);
      }
    }
    // 列と列の間
    for (let i = 0; i < 3; i++) {
      const d = distanceM(pts[i], pts[3 + i]);
      expect(Math.abs(d - 3)).toBeLessThanOrEqual(0.05);
    }
    // 対角は 3√2
    expect(distanceM(pts[0], pts[4])).toBeCloseTo(3 * Math.SQRT2, 1);
  });

  it("最初の点は origin、列方向は bearing に沿う", () => {
    const pts = gridPoints({ origin, bearing: 90, spacingM: 3, rows: 1, perRow: 2 });
    expect(pts[0].lat).toBe(origin.lat);
    expect(pts[0].lng).toBe(origin.lng);
    expect(bearingDeg(pts[0], pts[1])).toBeCloseTo(90, 4);
  });

  it("2 列目は列方向を時計回りに 90 度回した側にある", () => {
    const pts = gridPoints({ origin, bearing: 0, spacingM: 3, rows: 2, perRow: 1 });
    // 北向きの列なら、2 列目は東側
    expect(bearingDeg(pts[0], pts[1])).toBeCloseTo(90, 4);
  });

  it("株間を変えると間隔が変わる", () => {
    const pts = gridPoints({ origin, bearing: 10, spacingM: 2.5, rows: 1, perRow: 2 });
    expect(distanceM(pts[0], pts[1])).toBeCloseTo(2.5, 3);
  });

  it("不正な値は例外", () => {
    expect(() => gridPoints({ origin, bearing: 0, spacingM: 3, rows: 0, perRow: 1 })).toThrow();
    expect(() => gridPoints({ origin, bearing: 0, spacingM: 3, rows: 1, perRow: 1.5 })).toThrow();
    expect(() => gridPoints({ origin, bearing: 0, spacingM: 0, rows: 1, perRow: 1 })).toThrow();
  });
});
