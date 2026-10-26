import { describe, expect, it } from "vitest";
import { addDays, eachDate } from "./dates";
import { fillStartDate, missingRanges, planSync, type ExistingDay } from "./plan";

const TODAY = "2026-10-26";

function existingFor(dates: string[], day: ExistingDay = { api: "archive", offset: 0 }) {
  return new Map(dates.map((d) => [d, day] as const));
}

describe("missingRanges（欠けた日の検出）", () => {
  it("確定値のない日を連続した期間にまとめる", () => {
    const dates = eachDate("2026-01-01", "2026-01-10");
    const existing = existingFor(["2026-01-03", "2026-01-04", "2026-01-08"]);
    expect(missingRanges(dates, existing, 0)).toEqual([
      { from: "2026-01-01", to: "2026-01-02" },
      { from: "2026-01-05", to: "2026-01-07" },
      { from: "2026-01-09", to: "2026-01-10" },
    ]);
  });

  it("予報 API の暫定値（api=forecast）の日は欠けた日として取り直す", () => {
    const dates = eachDate("2026-01-01", "2026-01-03");
    const existing = new Map<string, ExistingDay>([
      ["2026-01-01", { api: "archive", offset: 0 }],
      ["2026-01-02", { api: "forecast", offset: 0 }],
      ["2026-01-03", { api: "archive", offset: 0 }],
    ]);
    expect(missingRanges(dates, existing, 0)).toEqual([{ from: "2026-01-02", to: "2026-01-02" }]);
  });

  it("補正（temperature_offset_c）が今の値と違う日は取り直す", () => {
    const dates = eachDate("2026-01-01", "2026-01-02");
    const existing = existingFor(dates, { api: "archive", offset: 0.5 });
    expect(missingRanges(dates, existing, 0)).toEqual([{ from: "2026-01-01", to: "2026-01-02" }]);
    expect(missingRanges(dates, existing, 0.5)).toEqual([]);
  });

  it("長い期間は chunkDays 日ずつに分ける", () => {
    const dates = eachDate("2026-01-01", "2026-01-10");
    expect(missingRanges(dates, new Map(), 0, 4)).toEqual([
      { from: "2026-01-01", to: "2026-01-04" },
      { from: "2026-01-05", to: "2026-01-08" },
      { from: "2026-01-09", to: "2026-01-10" },
    ]);
  });

  it("全部そろっていれば空", () => {
    const dates = eachDate("2026-01-01", "2026-01-05");
    expect(missingRanges(dates, existingFor(dates), 0)).toEqual([]);
  });
});

describe("planSync", () => {
  it("登録日（埋めるべき開始日）〜 確定値が出ている日（今日の 5 日前）を過去 API で取る。新しい順", () => {
    const plan = planSync({ today: TODAY, fillStart: "2026-09-01", includeNormals: false, existing: new Map(), offset: 0 });
    expect(plan.archiveRanges).toEqual([{ from: "2026-09-01", to: "2026-10-21" }]);
    expect(plan.missingCount).toBe(51);
    expect(plan.hourlyFrom).toBe("2026-09-01");
  });

  it("直近 7 日（今日を含まない）は予報 API の値で書く。確定値がある日は書かない", () => {
    const existing = existingFor(["2026-10-19", "2026-10-20"]);
    const plan = planSync({ today: TODAY, fillStart: TODAY, includeNormals: false, existing, offset: 0 });
    expect([...plan.forecastDates].sort()).toEqual(eachDate("2026-10-21", "2026-10-25"));
  });

  it("今日登録した圃場（茎なし）は過去 API の対象がなく、予報 API で昨日までの 7 日を取る", () => {
    const plan = planSync({ today: TODAY, fillStart: TODAY, includeNormals: false, existing: new Map(), offset: 0 });
    expect(plan.archiveRanges).toEqual([]);
    expect([...plan.forecastDates].sort()).toEqual(eachDate("2026-10-19", "2026-10-25"));
  });

  it("2 回目（前回ですべて確定済み）は過去 API の対象がない（重複して取らない）", () => {
    const fillStart = "2026-09-01";
    const all = eachDate(fillStart, addDays(TODAY, -5));
    const existing = existingFor(all);
    for (const d of eachDate(addDays(TODAY, -4), addDays(TODAY, -1))) existing.set(d, { api: "forecast", offset: 0 });
    const plan = planSync({ today: TODAY, fillStart, includeNormals: false, existing, offset: 0 });
    expect(plan.archiveRanges).toEqual([]);
    expect(plan.missingCount).toBe(0);
  });

  it("前回に失敗して欠けた日だけを、次回に取る", () => {
    const fillStart = "2026-09-01";
    const existing = existingFor(eachDate(fillStart, "2026-10-21"));
    for (const d of eachDate("2026-09-10", "2026-09-12")) existing.delete(d);
    existing.delete("2026-10-01");
    const plan = planSync({ today: TODAY, fillStart, includeNormals: false, existing, offset: 0 });
    expect(plan.archiveRanges).toEqual([
      { from: "2026-10-01", to: "2026-10-01" },
      { from: "2026-09-10", to: "2026-09-12" },
    ]);
  });

  it("予報 API の暫定値が 5 日より古くなったら、過去 API の確定値で取り直す（埋めるべき期間より前の日も）", () => {
    // 10/20 に登録した圃場。予報 API が 10/13〜10/19 を暫定値で入れている
    const existing = existingFor(eachDate("2026-10-13", "2026-10-25"), { api: "forecast", offset: 0 });
    const plan = planSync({ today: TODAY, fillStart: "2026-10-20", includeNormals: false, existing, offset: 0 });
    expect(plan.archiveRanges).toEqual([{ from: "2026-10-13", to: "2026-10-21" }]);
  });

  it("平年値の材料: 今年 1/1 の 10 年前から昨年末まで（日次）。埋めるべき期間の後に、新しい順", () => {
    const plan = planSync({ today: TODAY, fillStart: "2026-09-01", includeNormals: true, existing: new Map(), offset: 0 });
    const first = plan.archiveRanges[0];
    expect(first).toEqual({ from: "2026-09-01", to: "2026-10-21" });
    // 平年値の材料と埋めるべき期間の間（2026-01-01〜08-31）は取らない
    const covered = new Set(plan.archiveRanges.flatMap((r) => eachDate(r.from, r.to)));
    expect(covered.has("2026-01-01")).toBe(false);
    expect(covered.has("2026-08-31")).toBe(false);
    expect(covered.has("2016-01-01")).toBe(true);
    expect(covered.has("2025-12-31")).toBe(true);
    expect(covered.has("2015-12-31")).toBe(false);
    expect(plan.missingCount).toBe(eachDate("2016-01-01", "2025-12-31").length + 51);
    // 各期間は 366 日以内、新しい順
    for (const r of plan.archiveRanges) expect(eachDate(r.from, r.to).length).toBeLessThanOrEqual(366);
    const starts = plan.archiveRanges.map((r) => r.from);
    expect([...starts].sort().reverse()).toEqual(starts);
    // 時間別は埋めるべき期間だけ
    expect(plan.hourlyFrom).toBe("2026-09-01");
  });

  it("最も古い茎が平年値の材料の期間に重なっても、同じ日を 2 回取らない", () => {
    const plan = planSync({ today: TODAY, fillStart: "2025-06-01", includeNormals: true, existing: new Map(), offset: 0 });
    const all = plan.archiveRanges.flatMap((r) => eachDate(r.from, r.to));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(eachDate("2016-01-01", "2026-10-21").length);
  });
});

describe("fillStartDate（埋めるべき開始日）", () => {
  it("圃場の登録日と最も古い茎の started_at の早い方", () => {
    expect(fillStartDate("2026-10-01", "2026-03-15")).toBe("2026-03-15");
    expect(fillStartDate("2026-10-01", "2026-10-20")).toBe("2026-10-01");
    expect(fillStartDate("2026-10-01", null)).toBe("2026-10-01");
  });
});
