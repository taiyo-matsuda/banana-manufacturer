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

describe("nextMatCodes: 圃場記号を変えた後（UX-2）", () => {
  // 圃場記号を変えても既存の株コードは変えない。採番は既存の最大番号の次なので、新しい記号で番号は続きから
  it("A の株が 001〜006 ある圃場の記号を B に変えると、次は B-007", () => {
    const existing = ["A-001", "A-002", "A-003", "A-004", "A-005", "A-006"];
    expect(nextMatCodes("B", existing, 1)).toEqual(["B-007"]);
    expect(nextMatCodes("B", existing, 2)).toEqual(["B-007", "B-008"]);
  });
  it("古い記号と新しい記号の株が混ざっていても、全体の最大番号の次から", () => {
    expect(nextMatCodes("B", ["A-001", "A-006", "B-007"], 1)).toEqual(["B-008"]);
    expect(nextMatCodes("C", ["A-010", "B-003"], 1)).toEqual(["C-011"]);
  });
});
