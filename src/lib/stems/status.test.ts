import { describe, expect, it } from "vitest";
import { generationLabel, sortStemsByGeneration, STEM_STATUSES, stemStatusLabel } from "./status";

describe("stemStatusLabel", () => {
  it("すべての状態に日本語の文言がある", () => {
    for (const s of STEM_STATUSES) expect(stemStatusLabel(s)).not.toBe(s);
    expect(stemStatusLabel("active")).toBe("栽培中");
    expect(stemStatusLabel("flowered")).toBe("出蕾済み");
  });
  it("未知の状態はそのまま返す", () => {
    expect(stemStatusLabel("unknown")).toBe("unknown");
  });
});

describe("generationLabel", () => {
  it("親・子・孫、それ以降は n 代目", () => {
    expect(generationLabel(1)).toBe("親");
    expect(generationLabel(2)).toBe("子");
    expect(generationLabel(3)).toBe("孫");
    expect(generationLabel(4)).toBe("4 代目");
  });
});

describe("sortStemsByGeneration", () => {
  it("世代の昇順。同じ世代は started_at の早い順。元の配列は変えない", () => {
    const stems = [
      { id: "c", generation: 3, started_at: "2026-09-01" },
      { id: "b2", generation: 2, started_at: "2026-08-15" },
      { id: "a", generation: 1, started_at: "2026-01-01" },
      { id: "b1", generation: 2, started_at: "2026-08-01" },
    ];
    const sorted = sortStemsByGeneration(stems);
    expect(sorted.map((s) => s.id)).toEqual(["a", "b1", "b2", "c"]);
    expect(stems[0].id).toBe("c");
  });
  it("空なら空", () => {
    expect(sortStemsByGeneration([])).toEqual([]);
  });
});
