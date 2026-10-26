import { describe, expect, it } from "vitest";
import { addDays, daysBetween, eachDate, isDateString, jstDateOf, normalsRange } from "./dates";

describe("normalsRange（平年値の材料の期間）", () => {
  it("今年 1/1 の 10 年前から昨年末まで", () => {
    expect(normalsRange("2026-10-26")).toEqual({ from: "2016-01-01", to: "2025-12-31" });
    expect(normalsRange("2027-01-01")).toEqual({ from: "2017-01-01", to: "2026-12-31" });
  });
  it("日数は約 3,650（うるう年を含めて 3,653）", () => {
    const { from, to } = normalsRange("2026-10-26");
    expect(eachDate(from, to).length).toBe(3653);
  });
});

describe("日付の計算", () => {
  it("addDays は月・年・うるう日をまたぐ", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
  });
  it("daysBetween / eachDate", () => {
    expect(daysBetween("2026-10-19", "2026-10-26")).toBe(7);
    expect(eachDate("2026-10-24", "2026-10-26")).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
    expect(eachDate("2026-10-26", "2026-10-25")).toEqual([]);
  });
  it("jstDateOf は日本時間の日付（UTC 15:00 以降は翌日）", () => {
    expect(jstDateOf("2026-10-25T14:59:00Z")).toBe("2026-10-25");
    expect(jstDateOf("2026-10-25T15:00:00Z")).toBe("2026-10-26");
  });
  it("isDateString", () => {
    expect(isDateString("2026-02-28")).toBe(true);
    expect(isDateString("2026-02-30")).toBe(false);
    expect(isDateString("2026-2-3")).toBe(false);
  });
});
