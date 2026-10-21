import { describe, expect, it } from "vitest";
import {
  cumulativeLeaves,
  cumulativeLeavesByCheck,
  needsLeafCheck,
  type LeafObservation,
} from "./leaves";

const d = (s: string) => new Date(s);

describe("cumulativeLeaves", () => {
  it("初期葉数に leaves_new を足す", () => {
    const obs: LeafObservation[] = [
      { type: "leaves_new", value: 1, observedAt: d("2026-11-01") },
      { type: "leaves_new", value: 2, observedAt: d("2026-11-10") },
      { type: "leaves_current", value: 8, observedAt: d("2026-11-10") },
    ];
    expect(cumulativeLeaves(5, obs)).toBe(8);
  });

  it("観測がなければ初期葉数のまま", () => {
    expect(cumulativeLeaves(4, [])).toBe(4);
  });
});

describe("cumulativeLeavesByCheck", () => {
  it("最新の leaves_current にそれまでの除去枚数を足す", () => {
    const obs: LeafObservation[] = [
      { type: "leaves_current", value: 10, observedAt: d("2026-11-01") },
      { type: "leaves_current", value: 9, observedAt: d("2026-12-01") },
    ];
    const removed = [
      { count: 2, occurredAt: d("2026-11-15") },
      { count: 1, occurredAt: d("2026-12-15") }, // 最新観測より後なので含めない
    ];
    expect(cumulativeLeavesByCheck(obs, removed)).toBe(11);
  });

  it("leaves_current がなければ null", () => {
    expect(cumulativeLeavesByCheck([], [])).toBeNull();
  });
});

describe("needsLeafCheck", () => {
  it("差が3枚以上なら確認が必要", () => {
    expect(needsLeafCheck(20, 17)).toBe(true);
    expect(needsLeafCheck(20, 18)).toBe(false);
  });

  it("検算値がなければ確認不要", () => {
    expect(needsLeafCheck(20, null)).toBe(false);
  });
});
