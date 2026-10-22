import { describe, expect, it } from "vitest";
import { formatMatCode, nextMatCodes, parseMatCodeNumber } from "./code";

describe("formatMatCode", () => {
  it("3 桁ゼロ埋め", () => {
    expect(formatMatCode("A", 1)).toBe("A-001");
    expect(formatMatCode("AB12", 12)).toBe("AB12-012");
    expect(formatMatCode("A", 1000)).toBe("A-1000");
  });
});

describe("parseMatCodeNumber", () => {
  it("末尾の番号を読む", () => {
    expect(parseMatCodeNumber("A-012")).toBe(12);
    expect(parseMatCodeNumber("A-1000")).toBe(1000);
  });
  it("形式に合わなければ null", () => {
    expect(parseMatCodeNumber("A")).toBeNull();
    expect(parseMatCodeNumber("A-x")).toBeNull();
    expect(parseMatCodeNumber("")).toBeNull();
  });
});

describe("nextMatCodes", () => {
  it("株がなければ 001 から", () => {
    expect(nextMatCodes("A", [], 3)).toEqual(["A-001", "A-002", "A-003"]);
  });
  it("既存の最大番号の次から", () => {
    expect(nextMatCodes("A", ["A-002", "A-006", "A-001"], 2)).toEqual(["A-007", "A-008"]);
  });
  it("形式に合わないコードは無視する", () => {
    expect(nextMatCodes("A", ["旧-3", "A-004"], 1)).toEqual(["A-005"]);
  });
  it("0 個なら空", () => {
    expect(nextMatCodes("A", ["A-001"], 0)).toEqual([]);
  });
});
