import { describe, expect, it } from "vitest";
import { LAST_FIELD_KEY, mapTabHref, parseLastField, shouldClearForUser, USER_SCOPED_KEYS } from "./device-prefs";
import { RECENT_MATS_KEY } from "./recent-mats";

describe("shouldClearForUser", () => {
  it("持ち主が未記録・別のユーザーなら消す", () => {
    expect(shouldClearForUser(null, "u1")).toBe(true);
    expect(shouldClearForUser("u2", "u1")).toBe(true);
  });
  it("同じユーザーなら消さない", () => {
    expect(shouldClearForUser("u1", "u1")).toBe(false);
  });
  it("消す対象は最近開いた株と直近の圃場", () => {
    expect([...USER_SCOPED_KEYS].sort()).toEqual([LAST_FIELD_KEY, RECENT_MATS_KEY].sort());
  });
});

describe("parseLastField", () => {
  it("壊れた値・id の無い値は null", () => {
    expect(parseLastField(null)).toBeNull();
    expect(parseLastField("")).toBeNull();
    expect(parseLastField("{")).toBeNull();
    expect(parseLastField('"x"')).toBeNull();
    expect(parseLastField('{"name":"A"}')).toBeNull();
    expect(parseLastField('{"id":""}')).toBeNull();
  });
  it("id と名前を読む（名前が無ければ空）", () => {
    expect(parseLastField('{"id":"f1","name":"第1圃場"}')).toEqual({ id: "f1", name: "第1圃場" });
    expect(parseLastField('{"id":"f1"}')).toEqual({ id: "f1", name: "" });
  });
});

describe("mapTabHref", () => {
  it("直近の圃場があればその地図、無ければ圃場選択", () => {
    expect(mapTabHref({ id: "f1", name: "A" })).toBe("/fields/f1/map");
    expect(mapTabHref(null)).toBe("/map");
  });
});
