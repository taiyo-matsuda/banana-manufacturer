import { describe, expect, it } from "vitest";
import {
  buildForecast,
  forecastUnavailableLabel,
  weekRelativeLabel,
  weekStartOf,
  type ForecastStemInput,
} from "./forecast";
import type { HarvestDisplay } from "./prediction/harvest";

// 2026-10-30 は金曜。今週 = 10/26（月）〜11/1（日）
const TODAY = "2026-10-30";

function ok(valueDate: string, needsReview = false, lowerDate = valueDate, upperDate = valueDate): HarvestDisplay {
  return { state: "ok", valueDate, lowerDate, upperDate, needsReview, computedAt: "2026-10-30T00:00:00Z" };
}

let seq = 0;
function stem(estimate: HarvestDisplay | null, over: Partial<ForecastStemInput> = {}): ForecastStemInput {
  seq += 1;
  return {
    stemId: `s${seq}`,
    matId: `m${seq}`,
    matCode: `A-${String(seq).padStart(3, "0")}`,
    fieldId: "f1",
    fieldName: "圃場 1",
    generation: 1,
    status: "flowered",
    budDate: "2026-09-01",
    estimate,
    ...over,
  };
}

describe("weekStartOf（月曜始まり）", () => {
  it("月曜はその日、日曜は 6 日前の月曜", () => {
    expect(weekStartOf("2026-10-26")).toBe("2026-10-26"); // 月
    expect(weekStartOf("2026-10-30")).toBe("2026-10-26"); // 金
    expect(weekStartOf("2026-11-01")).toBe("2026-10-26"); // 日
    expect(weekStartOf("2026-11-02")).toBe("2026-11-02"); // 月
  });
  it("月・年をまたぐ週", () => {
    expect(weekStartOf("2027-01-01")).toBe("2026-12-28"); // 金
    expect(weekStartOf("2026-03-01")).toBe("2026-02-23"); // 日
    expect(weekStartOf("2028-03-01")).toBe("2028-02-28"); // 閏年の水曜
  });
});

describe("buildForecast", () => {
  it("予測日の週（月〜日）に数え、週は予測日の順。空の週は出さない", () => {
    const r = buildForecast(
      [
        stem(ok("2026-11-08")), // 日曜 → 11/2 の週
        stem(ok("2026-11-02")), // 月曜 → 11/2 の週
        stem(ok("2026-10-30")), // 今日 → 今週
        stem(ok("2026-10-26")), // 今週の月曜（今日より前でも今週）
        stem(ok("2026-11-23")),
      ],
      TODAY,
    );
    expect(r.thisWeekStart).toBe("2026-10-26");
    expect(r.weeks).toEqual([
      { weekStart: "2026-10-26", weekEnd: "2026-11-01", count: 2, needsReview: 0 },
      { weekStart: "2026-11-02", weekEnd: "2026-11-08", count: 2, needsReview: 0 },
      { weekStart: "2026-11-23", weekEnd: "2026-11-29", count: 1, needsReview: 0 },
    ]);
    expect(r.total).toEqual({ count: 5, needsReview: 0 });
    expect(r.rows.map((x) => x.valueDate)).toEqual(["2026-10-26", "2026-10-30", "2026-11-02", "2026-11-08", "2026-11-23"]);
  });

  it("lost・収穫済み・栽培中（出蕾前）の茎は数えない", () => {
    const r = buildForecast(
      [
        stem(ok("2026-11-03"), { status: "lost" }),
        stem(ok("2026-11-03"), { status: "harvested" }),
        stem(null, { status: "active" }),
        stem(ok("2026-11-03")),
      ],
      TODAY,
    );
    expect(r.weeks).toEqual([{ weekStart: "2026-11-02", weekEnd: "2026-11-08", count: 1, needsReview: 0 }]);
    expect(r.rows).toHaveLength(1);
    expect(r.unavailable).toHaveLength(0);
  });

  it("要確認の茎は本数に入れず、同じ週の別枠に数える", () => {
    const r = buildForecast([stem(ok("2026-11-03")), stem(ok("2026-11-04", true)), stem(ok("2026-11-20", true))], TODAY);
    expect(r.weeks).toEqual([
      { weekStart: "2026-11-02", weekEnd: "2026-11-08", count: 1, needsReview: 1 },
      { weekStart: "2026-11-16", weekEnd: "2026-11-22", count: 0, needsReview: 1 },
    ]);
    expect(r.total).toEqual({ count: 1, needsReview: 2 });
    expect(r.rows.filter((x) => x.needsReview).map((x) => x.valueDate)).toEqual(["2026-11-04", "2026-11-20"]);
  });

  it("予測日が今週より前の茎は「予測日を過ぎた」にまとめ、週の表には出さない", () => {
    const r = buildForecast([stem(ok("2026-10-25")), stem(ok("2026-10-01", true)), stem(ok("2026-11-01"))], TODAY);
    expect(r.overdue).toEqual({ count: 1, needsReview: 1 });
    expect(r.weeks).toEqual([{ weekStart: "2026-10-26", weekEnd: "2026-11-01", count: 1, needsReview: 0 }]);
    expect(r.rows.find((x) => x.valueDate === "2026-10-25")?.overdue).toBe(true);
    expect(r.rows.find((x) => x.valueDate === "2026-11-01")?.overdue).toBe(false);
    expect(r.total).toEqual({ count: 2, needsReview: 1 });
  });

  it("予測できなかった茎・推定の無い茎は週に数えず、理由付きで別に並べる", () => {
    const r = buildForecast(
      [
        stem({ state: "unavailable", reason: "normals_gap", date: "2027-01-10", needsReview: true, computedAt: "x" }, { matCode: "B-002" }),
        stem(null, { matCode: "B-001" }),
        stem(ok("2026-11-03")),
      ],
      TODAY,
    );
    expect(r.total).toEqual({ count: 1, needsReview: 0 });
    expect(r.unavailable.map((u) => [u.matCode, u.reason, u.reasonDate, u.needsReview])).toEqual([
      ["B-001", "pending", null, false],
      ["B-002", "normals_gap", "2027-01-10", true],
    ]);
  });

  it("幅が 3 週以上にまたがっても不確実（別枠）にしない（prediction.md 8 章）", () => {
    const r = buildForecast([stem(ok("2026-11-18", false, "2026-10-27", "2026-12-10"))], TODAY);
    expect(r.weeks).toEqual([{ weekStart: "2026-11-16", weekEnd: "2026-11-22", count: 1, needsReview: 0 }]);
  });

  it("同じ予測日は株コード・世代の順", () => {
    const r = buildForecast(
      [
        stem(ok("2026-11-03"), { matCode: "A-010", generation: 2 }),
        stem(ok("2026-11-03"), { matCode: "A-002" }),
        stem(ok("2026-11-03"), { matCode: "A-010", generation: 1 }),
      ],
      TODAY,
    );
    expect(r.rows.map((x) => `${x.matCode}/${x.generation}`)).toEqual(["A-002/1", "A-010/1", "A-010/2"]);
  });

  it("茎が無ければ空", () => {
    const r = buildForecast([], TODAY);
    expect(r.weeks).toEqual([]);
    expect(r.overdue).toEqual({ count: 0, needsReview: 0 });
    expect(r.rows).toEqual([]);
  });
});

describe("表示の補助", () => {
  it("今週・来週・再来週", () => {
    expect(weekRelativeLabel("2026-10-26", "2026-10-26")).toBe("今週");
    expect(weekRelativeLabel("2026-11-02", "2026-10-26")).toBe("来週");
    expect(weekRelativeLabel("2026-11-09", "2026-10-26")).toBe("再来週");
    expect(weekRelativeLabel("2026-11-16", "2026-10-26")).toBeNull();
  });
  it("予測できない理由", () => {
    expect(forecastUnavailableLabel("pending")).toContain("まだ計算されていません");
    expect(forecastUnavailableLabel("never_reaches")).toContain("730 日");
  });
});
