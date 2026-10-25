import { describe, expect, it } from "vitest";
import { newObservationItem, newStemEventItem } from "./offline/items";
import {
  applyOutboxToWeekly,
  computeWeekly,
  daysBetween,
  daysSinceLabel,
  parseWeeklyThreshold,
  weeklyHoldKey,
  weeklyServerKeys,
  type WeeklyStemRow,
} from "./weekly";

const TODAY = "2026-10-25";

// 日本時間 YYYY-MM-DD の正午（UTC 03:00）
const jstNoon = (date: string) => `${date}T03:00:00.000Z`;
// n 日前の日付
function daysAgo(n: number): string {
  const d = new Date(Date.UTC(2026, 9, 25 - n));
  return d.toISOString().slice(0, 10);
}

let seq = 0;
function row(over: Partial<WeeklyStemRow> & { mat_id: string }): WeeklyStemRow {
  seq += 1;
  return {
    stem_id: `s${seq}`,
    mat_code: over.mat_id.toUpperCase(),
    mat_status: "active",
    field_id: "f1",
    field_name: "圃場1",
    generation: 1,
    status: "active",
    started_at: "2026-09-01",
    bud_emerged_at: null,
    initial_leaf_count: 5,
    last_leaves_new_at: null,
    leaves_new_sum: 0,
    ...over,
  };
}

const codes = (items: { matCode: string }[]) => items.map((i) => i.matCode);

describe("daysBetween / daysSinceLabel / parseWeeklyThreshold", () => {
  it("日付の差を日数で返す（月・年またぎ）", () => {
    expect(daysBetween("2026-10-17", "2026-10-25")).toBe(8);
    expect(daysBetween("2026-09-30", "2026-10-01")).toBe(1);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
    expect(daysBetween("2026-10-25", "2026-10-25")).toBe(0);
  });
  it("表示", () => {
    expect(daysSinceLabel(9)).toBe("9 日前");
    expect(daysSinceLabel(0)).toBe("今日");
  });
  it("閾値は 7 / 14 のみ。それ以外は 7", () => {
    expect(parseWeeklyThreshold("14")).toBe(14);
    expect(parseWeeklyThreshold("7")).toBe(7);
    expect(parseWeeklyThreshold("10")).toBe(7);
    expect(parseWeeklyThreshold(null)).toBe(7);
    expect(parseWeeklyThreshold("abc")).toBe(7);
  });
});

describe("computeWeekly: 閾値", () => {
  const rows = [
    row({ mat_id: "m6", last_leaves_new_at: jstNoon(daysAgo(6)) }),
    row({ mat_id: "m7", last_leaves_new_at: jstNoon(daysAgo(7)) }),
    row({ mat_id: "m8", last_leaves_new_at: jstNoon(daysAgo(8)) }),
    row({ mat_id: "m2", last_leaves_new_at: jstNoon(daysAgo(2)) }),
  ];
  it("7 日: 7・8 日は出て 6 日・2 日は出ない（境界は「以上」）。経過日数の長い順", () => {
    const items = computeWeekly(rows, TODAY, 7);
    expect(codes(items)).toEqual(["M8", "M7"]);
    expect(items.map((i) => i.daysSince)).toEqual([8, 7]);
  });
  it("14 日: 8 日前の株も出ない", () => {
    expect(computeWeekly(rows, TODAY, 14)).toEqual([]);
    const r14 = [row({ mat_id: "m14", last_leaves_new_at: jstNoon(daysAgo(14)) })];
    expect(codes(computeWeekly(r14, TODAY, 14))).toEqual(["M14"]);
  });
});

describe("computeWeekly: 株の経過日数・代表の茎", () => {
  it("株の中で一番見ていない茎の日から数える", () => {
    const items = computeWeekly(
      [
        row({ mat_id: "m1", last_leaves_new_at: jstNoon(daysAgo(3)) }),
        row({ mat_id: "m1", generation: 2, last_leaves_new_at: jstNoon(daysAgo(10)) }),
      ],
      TODAY,
      7,
    );
    expect(items).toHaveLength(1);
    expect(items[0].daysSince).toBe(10);
  });

  it("観測なしの茎は started_at から数える", () => {
    const items = computeWeekly([row({ mat_id: "m1", started_at: daysAgo(9) }), row({ mat_id: "m2", started_at: daysAgo(3) })], TODAY, 7);
    expect(codes(items)).toEqual(["M1"]);
    expect(items[0].daysSince).toBe(9);
  });

  it("代表の茎: flowered を優先、同じ状態なら世代の若い茎。累計葉数は代表の茎（初期 + Σ）", () => {
    const items = computeWeekly(
      [
        row({ mat_id: "m1", stem_id: "child", generation: 2, status: "flowered", bud_emerged_at: daysAgo(5), initial_leaf_count: 3, leaves_new_sum: 30, last_leaves_new_at: jstNoon(daysAgo(1)) }),
        row({ mat_id: "m1", stem_id: "parent", generation: 1, status: "active", initial_leaf_count: 10, leaves_new_sum: 2, last_leaves_new_at: jstNoon(daysAgo(1)) }),
        row({ mat_id: "m2", stem_id: "p2", generation: 1, initial_leaf_count: 4, leaves_new_sum: 6, last_leaves_new_at: jstNoon(daysAgo(9)) }),
        row({ mat_id: "m2", stem_id: "c2", generation: 2, initial_leaf_count: 1, leaves_new_sum: 1, last_leaves_new_at: jstNoon(daysAgo(9)) }),
      ],
      TODAY,
      7,
    );
    expect(items[0]).toMatchObject({ matId: "m1", stemId: "child", stemStatus: "flowered", cumulativeLeaves: 33, flowered: true });
    expect(items[1]).toMatchObject({ matId: "m2", stemId: "p2", stemStatus: "active", cumulativeLeaves: 10 });
  });

  it("対象外の状態（吸芽・収穫済みなど）の茎は無視し、撤去済みの株は出さない", () => {
    const items = computeWeekly(
      [
        row({ mat_id: "m1", status: "harvested", started_at: daysAgo(100) }),
        row({ mat_id: "m2", status: "sucker", started_at: daysAgo(100) }),
        row({ mat_id: "m3", mat_status: "removed", started_at: daysAgo(100) }),
        row({ mat_id: "m3", mat_status: "removed", status: "flowered", bud_emerged_at: daysAgo(3) }),
        row({ mat_id: "m4", started_at: daysAgo(100) }),
        // 収穫済みの茎は古くても経過日数に入れない
        row({ mat_id: "m5", status: "harvested", started_at: daysAgo(100) }),
        row({ mat_id: "m5", generation: 2, started_at: daysAgo(2) }),
      ],
      TODAY,
      7,
    );
    expect(codes(items)).toEqual(["M4"]);
  });
});

describe("computeWeekly: 出蕾済み", () => {
  it("出蕾済みの株は閾値に関係なく上に出す（出蕾日の古い順）。それ以外は経過日数の長い順、同じなら株コード順", () => {
    const items = computeWeekly(
      [
        row({ mat_id: "a10", mat_code: "A-010", last_leaves_new_at: jstNoon(daysAgo(9)) }),
        row({ mat_id: "a2", mat_code: "A-002", last_leaves_new_at: jstNoon(daysAgo(9)) }),
        row({ mat_id: "a3", mat_code: "A-003", last_leaves_new_at: jstNoon(daysAgo(20)) }),
        row({ mat_id: "f1", mat_code: "B-001", status: "flowered", bud_emerged_at: daysAgo(3), last_leaves_new_at: jstNoon(daysAgo(1)) }),
        row({ mat_id: "f2", mat_code: "B-002", status: "flowered", bud_emerged_at: daysAgo(30), last_leaves_new_at: jstNoon(daysAgo(2)) }),
      ],
      TODAY,
      7,
    );
    expect(codes(items)).toEqual(["B-002", "B-001", "A-003", "A-002", "A-010"]);
    expect(items[0]).toMatchObject({ flowered: true, budEmergedAt: daysAgo(30), daysSince: 2 });
  });

  it("出蕾済みの茎に今日 leaves_new を記録していたら出さない", () => {
    const items = computeWeekly(
      [row({ mat_id: "f1", status: "flowered", bud_emerged_at: daysAgo(3), last_leaves_new_at: `${TODAY}T01:00:00.000Z` })],
      TODAY,
      7,
    );
    expect(items).toEqual([]);
  });
});

describe("computeWeekly: 今日記録した株・タイムゾーン", () => {
  it("今日どれかの茎に記録した株は、他の茎が古くても出さない", () => {
    const items = computeWeekly(
      [
        row({ mat_id: "m1", last_leaves_new_at: `${TODAY}T00:30:00.000Z` }),
        row({ mat_id: "m1", generation: 2, last_leaves_new_at: jstNoon(daysAgo(20)) }),
        row({ mat_id: "m2", last_leaves_new_at: jstNoon(daysAgo(20)) }),
      ],
      TODAY,
      7,
    );
    expect(codes(items)).toEqual(["M2"]);
  });

  it("UTC では前日でも日本時間で今日の観測（UTC 10/24 16:00 = JST 10/25 01:00）は今日の記録", () => {
    const items = computeWeekly([row({ mat_id: "m1", started_at: daysAgo(30), last_leaves_new_at: "2026-10-24T16:00:00.000Z" })], TODAY, 7);
    expect(items).toEqual([]);
  });

  it("UTC の日付ではなく日本時間の日付で数える（UTC 10/17 15:30 = JST 10/18 → 7 日前、UTC 10/17 14:30 = JST 10/17 → 8 日前）", () => {
    const a = computeWeekly([row({ mat_id: "m1", last_leaves_new_at: "2026-10-17T15:30:00.000Z" })], TODAY, 7);
    expect(a[0].daysSince).toBe(7);
    const b = computeWeekly([row({ mat_id: "m1", last_leaves_new_at: "2026-10-17T14:30:00.000Z" })], TODAY, 7);
    expect(b[0].daysSince).toBe(8);
    // JST 10/19 00:30（UTC 10/18 15:30）は 6 日前なので出ない
    expect(computeWeekly([row({ mat_id: "m1", last_leaves_new_at: "2026-10-18T15:30:00.000Z" })], TODAY, 7)).toEqual([]);
  });
});

describe("computeWeekly: 訂正済みの観測", () => {
  it("view は訂正済み（superseded_by あり）の観測を含めない。訂正済みの観測だけの茎は last=null（観測なし）として started_at から数える", () => {
    // view weekly_stems の行の形（訂正済みの観測は last_leaves_new_at / leaves_new_sum に入らない）
    const items = computeWeekly([row({ mat_id: "m1", started_at: daysAgo(10), last_leaves_new_at: null, leaves_new_sum: 0, initial_leaf_count: 4 })], TODAY, 7);
    expect(items[0]).toMatchObject({ daysSince: 10, cumulativeLeaves: 4 });
  });
});

describe("applyOutboxToWeekly（未同期の重ね合わせ）", () => {
  const now = new Date(`${TODAY}T02:00:00.000Z`);

  it("未送信の leaves_new を重ねると、今日記録した株として消える。累計にも足す", () => {
    const rows = [row({ mat_id: "m1", stem_id: "s-a", last_leaves_new_at: jstNoon(daysAgo(8)), leaves_new_sum: 3 })];
    expect(codes(computeWeekly(rows, TODAY, 7))).toEqual(["M1"]);
    const item = newObservationItem({ id: "o1", createdAt: now, stemId: "s-a", type: "leaves_new", value: 1, observedAt: now, userId: "u" });
    const merged = applyOutboxToWeekly(rows, [item]);
    expect(merged[0].last_leaves_new_at).toBe(now.toISOString());
    expect(merged[0].leaves_new_sum).toBe(4);
    expect(computeWeekly(merged, TODAY, 7)).toEqual([]);
    // 元の配列は変えない
    expect(rows[0].leaves_new_sum).toBe(3);
  });

  it("過去日の未送信の観測は最後の日を戻さない。leaves_new 以外・一覧にない茎・同じ id の重複は無視", () => {
    const rows = [row({ mat_id: "m1", stem_id: "s-a", last_leaves_new_at: jstNoon(daysAgo(3)), leaves_new_sum: 0 })];
    const old = newObservationItem({ id: "o1", createdAt: now, stemId: "s-a", type: "leaves_new", value: 2, observedAt: new Date(jstNoon(daysAgo(9))), userId: "u" });
    const current = newObservationItem({ id: "o2", createdAt: now, stemId: "s-a", type: "leaves_current", value: 9, observedAt: now, userId: "u" });
    const other = newObservationItem({ id: "o3", createdAt: now, stemId: "s-x", type: "leaves_new", value: 1, observedAt: now, userId: "u" });
    const merged = applyOutboxToWeekly(rows, [old, old, current, other]);
    expect(merged).toHaveLength(1);
    expect(merged[0].last_leaves_new_at).toBe(jstNoon(daysAgo(3)));
    expect(merged[0].leaves_new_sum).toBe(2);
  });

  it("未送信の出蕾は出蕾済みに、収穫は対象外にする", () => {
    const rows = [
      row({ mat_id: "m1", stem_id: "s-a", last_leaves_new_at: jstNoon(daysAgo(2)) }),
      row({ mat_id: "m2", stem_id: "s-b", status: "flowered", bud_emerged_at: daysAgo(40), last_leaves_new_at: jstNoon(daysAgo(2)) }),
    ];
    const bud = newStemEventItem({ id: "e1", createdAt: now, stemId: "s-a", type: "bud_emerged", occurredAt: now.toISOString(), payload: {} });
    const harvest = newStemEventItem({ id: "e2", createdAt: now, stemId: "s-b", type: "harvested", occurredAt: now.toISOString(), payload: {} });
    const merged = applyOutboxToWeekly(rows, [bud, harvest]);
    expect(merged[0]).toMatchObject({ status: "flowered", bud_emerged_at: TODAY });
    expect(merged[1].status).toBe("harvested");
    const items = computeWeekly(merged, TODAY, 7);
    expect(codes(items)).toEqual(["M1"]);
    expect(items[0].flowered).toBe(true);
  });
});

describe("weeklyHoldKey / weeklyServerKeys", () => {
  it("送信済みの観測は、サーバーの一覧のその茎の最後の日（日本時間）が同じ日になれば反映済み", () => {
    const at = new Date("2026-10-24T16:00:00.000Z"); // JST 10/25
    const item = newObservationItem({ id: "o1", createdAt: at, stemId: "s-a", type: "leaves_new", value: 1, observedAt: at, userId: "u" });
    expect(weeklyHoldKey(item)).toBe("s-a@2026-10-25");
    const stale = [row({ mat_id: "m1", stem_id: "s-a", last_leaves_new_at: jstNoon(daysAgo(8)) })];
    expect(weeklyServerKeys(stale).has("s-a@2026-10-25")).toBe(false);
    const fresh = [row({ mat_id: "m1", stem_id: "s-a", last_leaves_new_at: "2026-10-25T00:00:00.000Z" })];
    expect(weeklyServerKeys(fresh).has("s-a@2026-10-25")).toBe(true);
    const current = newObservationItem({ id: "o2", createdAt: at, stemId: "s-a", type: "leaves_current", value: 1, observedAt: at, userId: "u" });
    expect(weeklyHoldKey(current)).toBeNull();
  });
});
