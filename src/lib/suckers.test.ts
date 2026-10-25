import { describe, expect, it } from "vitest";
import { eventLabel, eventValueText } from "./stems/records";
import {
  buildSuckerPayload,
  canHaveSucker,
  cumulativeLeavesAsOf,
  defaultSuckerEarliestAt,
  defaultSuckerParent,
  parseSuckerInput,
  SUCKER_DIRECTION_GRID,
  SUCKER_DIRECTIONS,
  suckerDirectionLabel,
  suckerEmergedValueText,
  suckerParentCandidates,
  suckerTypeLabel,
} from "./suckers";

const stem = (id: string, generation: number, status: string, started_at: string) => ({ id, generation, status, started_at });

describe("方向と種類のラベル", () => {
  it("8 方位を日本語にする", () => {
    expect(SUCKER_DIRECTIONS.map(suckerDirectionLabel)).toEqual(["北", "北東", "東", "南東", "南", "南西", "西", "北西"]);
    expect(suckerDirectionLabel("XX")).toBe("XX");
    expect(suckerDirectionLabel(undefined)).toBe("");
  });

  it("3×3 の配置は上が北・中央が空きで、8 方位を 1 回ずつ含む", () => {
    expect(SUCKER_DIRECTION_GRID).toEqual(["NW", "N", "NE", "W", null, "E", "SW", "S", "SE"]);
    expect(new Set(SUCKER_DIRECTION_GRID.filter((d) => d !== null))).toEqual(new Set(SUCKER_DIRECTIONS));
  });

  it("種類を日本語にする", () => {
    expect(suckerTypeLabel("sword")).toBe("剣葉");
    expect(suckerTypeLabel("water")).toBe("水吸芽");
    expect(suckerTypeLabel(1)).toBe("");
  });
});

describe("親茎の既定の選び方", () => {
  it("栽培中（active / flowered）だけが候補", () => {
    expect(["active", "flowered"].every(canHaveSucker)).toBe(true);
    expect(["sucker", "harvested", "removed", "transplanted", "lost"].some(canHaveSucker)).toBe(false);
  });

  it("候補は世代の若い順（同じ世代は started_at の早い順）。既定は先頭", () => {
    const stems = [
      stem("c", 2, "active", "2026-06-01"),
      stem("p", 1, "harvested", "2026-01-01"), // 収穫済みは候補外
      stem("b", 2, "flowered", "2026-05-01"),
      stem("s", 3, "sucker", "2026-09-01"), // 吸芽は候補外
      stem("g", 3, "active", "2026-08-01"),
    ];
    expect(suckerParentCandidates(stems).map((s) => s.id)).toEqual(["b", "c", "g"]);
    expect(defaultSuckerParent(stems)?.id).toBe("b");
  });

  it("候補がなければ null", () => {
    expect(defaultSuckerParent([stem("p", 1, "harvested", "2026-01-01"), stem("s", 2, "sucker", "2026-09-01")])).toBeNull();
    expect(defaultSuckerParent([])).toBeNull();
  });
});

describe("入力の解釈", () => {
  const candidates = [stem("p", 1, "active", "2026-01-01")];
  const ok = { parentStemId: "p", direction: "NE", suckerType: "sword", date: "2026-10-25", earliestAt: "2026-10-18" };

  it("正しい入力", () => {
    expect(parseSuckerInput(ok, candidates)).toEqual({
      ok: true,
      value: { parentStemId: "p", direction: "NE", suckerType: "sword", date: "2026-10-25", earliestAt: "2026-10-18" },
    });
    // 前回訪問日は空でもよい
    expect(parseSuckerInput({ ...ok, earliestAt: "" }, candidates)).toMatchObject({ ok: true, value: { earliestAt: null } });
  });

  it("親茎・方向・種類・日付が不正なら理由を返す", () => {
    expect(parseSuckerInput({ ...ok, parentStemId: "x" }, candidates)).toEqual({ ok: false, error: "親茎を選んでください" });
    expect(parseSuckerInput({ ...ok, direction: "" }, candidates)).toEqual({ ok: false, error: "方向を選んでください" });
    expect(parseSuckerInput({ ...ok, direction: "UP" }, candidates)).toEqual({ ok: false, error: "方向を選んでください" });
    expect(parseSuckerInput({ ...ok, suckerType: "" }, candidates)).toEqual({ ok: false, error: "種類を選んでください" });
    expect(parseSuckerInput({ ...ok, date: "2026-13-01" }, candidates)).toMatchObject({ ok: false });
    expect(parseSuckerInput({ ...ok, earliestAt: "abc" }, candidates)).toMatchObject({ ok: false });
    expect(parseSuckerInput({ ...ok, earliestAt: "2026-10-26" }, candidates)).toEqual({
      ok: false,
      error: "前回訪問日は確認日より前の日付にしてください",
    });
  });
});

describe("payload と履歴の表示", () => {
  it("data-model の表どおりの payload を組み立てる", () => {
    expect(
      buildSuckerPayload({ suckerStemId: "s1", parentCumulativeLeaves: 18, earliestAt: "2026-10-18", direction: "NE", suckerType: "sword" }),
    ).toEqual({ sucker_stem_id: "s1", parent_cumulative_leaves: 18, earliest_at: "2026-10-18", direction: "NE", sucker_type: "sword" });
  });

  it("親茎の履歴に「北東・剣葉・親の累計 18 枚」と出す", () => {
    const payload = { sucker_stem_id: "s1", parent_cumulative_leaves: 18, earliest_at: null, direction: "NE", sucker_type: "sword" };
    expect(suckerEmergedValueText(payload)).toBe("北東・剣葉・親の累計 18 枚");
    expect(eventLabel("sucker_emerged")).toBe("吸芽");
    expect(eventValueText("sucker_emerged", payload)).toBe("北東・剣葉・親の累計 18 枚");
    expect(suckerEmergedValueText({ direction: "W", sucker_type: "water", parent_cumulative_leaves: 0 })).toBe("西・水吸芽・親の累計 0 枚");
    expect(suckerEmergedValueText(null)).toBe("");
  });
});

describe("その時点の親の累計葉数", () => {
  const obs = [
    { type: "leaves_new", value: 2, observed_at: "2026-10-01T03:00:00Z" },
    { type: "leaves_current", value: 9, observed_at: "2026-10-01T03:00:00Z" }, // 数えない
    { type: "leaves_new", value: 1, observed_at: "2026-10-24T16:00:00Z" }, // JST では 10-25 01:00
    { type: "leaves_new", value: 3, observed_at: "2026-10-30T03:00:00Z" },
  ];

  it("初期葉数 + 確認日（日本時間）までの leaves_new の合計", () => {
    expect(cumulativeLeavesAsOf(5, obs, "2026-10-24")).toBe(7);
    expect(cumulativeLeavesAsOf(5, obs, "2026-10-25")).toBe(8);
    expect(cumulativeLeavesAsOf(5, obs, "2026-11-01")).toBe(11);
    expect(cumulativeLeavesAsOf(5, [], "2026-10-25")).toBe(5);
  });
});

describe("前回訪問日の既定値", () => {
  const ats = ["2026-10-01T03:00:00Z", "2026-10-24T16:00:00Z" /* JST 10-25 */, "2026-10-20T03:00:00Z", "bad"];

  it("確認日より前（確認日を含まない）の最新の観測日（日本時間）", () => {
    expect(defaultSuckerEarliestAt(ats, "2026-10-25")).toBe("2026-10-20");
    expect(defaultSuckerEarliestAt(ats, "2026-10-26")).toBe("2026-10-25");
    expect(defaultSuckerEarliestAt(ats, "2026-10-20")).toBe("2026-10-01");
  });

  it("確認日より前の観測がなければ null", () => {
    expect(defaultSuckerEarliestAt(ats, "2026-10-01")).toBeNull();
    expect(defaultSuckerEarliestAt([], "2026-10-25")).toBeNull();
  });
});
