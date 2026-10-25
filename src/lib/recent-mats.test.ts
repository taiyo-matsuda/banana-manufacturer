import { describe, expect, it } from "vitest";
import { parseRecentMats, pushRecentMat, RECENT_MATS_MAX, type RecentMat, removeRecentMat, renameFieldInRecentMats } from "./recent-mats";

const mat = (id: string, code = id.toUpperCase()): RecentMat => ({
  id,
  code,
  fieldName: "第1圃場",
  fieldId: "f1",
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
      { id: "a", code: "A-001", fieldName: "第1圃場", fieldId: null, openedAt: "2026-10-25T00:00:00.000Z" },
      { id: "b", code: "B-001", fieldName: null, fieldId: null, openedAt: "" },
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

describe("renameFieldInRecentMats（UX-2）", () => {
  it("その圃場の株だけ fieldName を新しい名前にし、並び順は変えない", () => {
    const list = [mat("a"), { ...mat("b"), fieldId: "f2", fieldName: "第2圃場" }, mat("c")];
    const next = renameFieldInRecentMats(list, "f1", "北の畑");
    expect(next.map((m) => [m.id, m.fieldName])).toEqual([
      ["a", "北の畑"],
      ["b", "第2圃場"],
      ["c", "北の畑"],
    ]);
  });
  it("変わる項目がなければ同じ配列を返す", () => {
    const list = [mat("a")];
    expect(renameFieldInRecentMats(list, "f1", "第1圃場")).toBe(list);
    expect(renameFieldInRecentMats(list, "other", "x")).toBe(list);
  });
});

describe("removeRecentMat", () => {
  const a = { id: "a", code: "A-001", fieldName: "北", fieldId: "f", openedAt: "" };
  const b = { id: "b", code: "A-002", fieldName: "北", fieldId: "f", openedAt: "" };
  it("撤去した株を外し、残りの順は変えない", () => {
    expect(removeRecentMat([a, b], "a")).toEqual([b]);
  });
  it("含まれていなければ同じ配列を返す", () => {
    const list = [a, b];
    expect(removeRecentMat(list, "z")).toBe(list);
  });
});
