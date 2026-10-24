import { describe, expect, it } from "vitest";
import { parseRecentMats, pushRecentMat, RECENT_MATS_MAX, type RecentMat } from "./recent-mats";

const mat = (id: string, code = id.toUpperCase()): RecentMat => ({
  id,
  code,
  fieldName: "第1圃場",
  openedAt: "2026-10-25T00:00:00.000Z",
});

describe("parseRecentMats", () => {
  it("null / 空 / 壊れた JSON / 配列でない値は空配列にする", () => {
    expect(parseRecentMats(null)).toEqual([]);
    expect(parseRecentMats("")).toEqual([]);
    expect(parseRecentMats("{")).toEqual([]);
    expect(parseRecentMats('{"id":"a"}')).toEqual([]);
  });

  it("id と code を持つ要素だけを残し、欠けた項目は既定値で埋める", () => {
    const raw = JSON.stringify([
      { id: "a", code: "A-001", fieldName: "第1圃場", openedAt: "2026-10-25T00:00:00.000Z" },
      { id: "b", code: "B-001" },
      { id: 1, code: "bad" },
      "junk",
      null,
    ]);
    expect(parseRecentMats(raw)).toEqual([
      { id: "a", code: "A-001", fieldName: "第1圃場", openedAt: "2026-10-25T00:00:00.000Z" },
      { id: "b", code: "B-001", fieldName: null, openedAt: "" },
    ]);
  });
});

describe("pushRecentMat", () => {
  it("先頭に追加する（新しい順）", () => {
    const list = pushRecentMat([mat("a")], mat("b"));
    expect(list.map((m) => m.id)).toEqual(["b", "a"]);
  });

  it("同じ株をもう一度開くと先頭に移り、重複しない", () => {
    const list = pushRecentMat([mat("a"), mat("b"), mat("c")], mat("b"));
    expect(list.map((m) => m.id)).toEqual(["b", "a", "c"]);
  });

  it("直近 5 件に切る", () => {
    let list: RecentMat[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) list = pushRecentMat(list, mat(id));
    expect(list).toHaveLength(RECENT_MATS_MAX);
    expect(list.map((m) => m.id)).toEqual(["g", "f", "e", "d", "c"]);
  });
});
