import { describe, expect, it } from "vitest";
import {
  buildHistory,
  canRecordLeaves,
  eventValueText,
  formatDateTime,
  observationValueText,
  parseLeavesCurrent,
  parseLeavesNew,
  parseLeavesRemoved,
  toLeafObservations,
  toLeavesRemoved,
} from "./records";

describe("canRecordLeaves", () => {
  it("栽培中（active / flowered）だけ記録できる", () => {
    expect(canRecordLeaves("active")).toBe(true);
    expect(canRecordLeaves("flowered")).toBe(true);
    for (const s of ["sucker", "harvested", "removed", "transplanted", "lost"]) {
      expect(canRecordLeaves(s)).toBe(false);
    }
  });
});

describe("枚数の入力", () => {
  it("leaves_new は 0 以上の整数（+0 も記録する）", () => {
    expect(parseLeavesNew("0")).toEqual({ ok: true, value: 0 });
    expect(parseLeavesNew(" 2 ")).toEqual({ ok: true, value: 2 });
    expect(parseLeavesNew("5")).toEqual({ ok: true, value: 5 });
    expect(parseLeavesNew("")).toEqual({ ok: false, error: "新たに開いた葉の枚数を入力してください" });
    expect(parseLeavesNew("-1").ok).toBe(false);
    expect(parseLeavesNew("1.5").ok).toBe(false);
    expect(parseLeavesNew("abc").ok).toBe(false);
  });

  it("leaves_current は 0 以上の整数", () => {
    expect(parseLeavesCurrent("8")).toEqual({ ok: true, value: 8 });
    expect(parseLeavesCurrent("0")).toEqual({ ok: true, value: 0 });
    expect(parseLeavesCurrent(null)).toEqual({ ok: false, error: "現在の葉数を入力してください" });
    expect(parseLeavesCurrent("-3")).toEqual({ ok: false, error: "現在の葉数は 0 以上の整数で入力してください" });
  });

  it("枯葉処理は 1 枚以上", () => {
    expect(parseLeavesRemoved("2")).toEqual({ ok: true, value: 2 });
    expect(parseLeavesRemoved("0")).toEqual({ ok: false, error: "除去した枚数は 1 以上の整数で入力してください" });
    expect(parseLeavesRemoved("")).toEqual({ ok: false, error: "除去した枚数を入力してください" });
  });
});

describe("値の表示", () => {
  it("観測: 新葉は増分、現在の葉数は枚", () => {
    expect(observationValueText("leaves_new", 1)).toBe("+1");
    expect(observationValueText("leaves_new", 0)).toBe("+0");
    expect(observationValueText("leaves_current", 8)).toBe("8 枚");
    expect(observationValueText("pseudostem_girth_cm", 45)).toBe("45 cm");
  });

  it("イベント: 枯葉処理は枚数、未知の payload は key=value", () => {
    expect(eventValueText("leaves_removed", { count: 2 })).toBe("2 枚");
    expect(eventValueText("leaves_removed", {})).toBe("");
    expect(eventValueText("harvested", { weight_kg: 12.5 })).toBe("12.5 kg");
    expect(eventValueText("bagged", {})).toBe("");
    expect(eventValueText("damage", { kind: "lodging", severity: "light" })).toBe("倒伏・軽");
    expect(eventValueText("bud_emerged", { cumulative_leaves: 12, leaves_current: 10, girth_cm: 45 })).toBe("累計葉数 12 枚・生葉数 10 枚・周囲長 45 cm");
    expect(eventValueText("fertilized", { fertilizer: "鶏糞", amount: 2, unit: "kg", batch_id: "b" })).toBe("鶏糞 2 kg");
    expect(eventValueText("mat_removed", { reason: "台風" })).toBe("台風");
    expect(eventValueText("mat_removed", {})).toBe("");
    expect(eventValueText("unknown_type", { a: 1 })).toBe("a=1");
  });

  it("日時は日本時間で分まで", () => {
    expect(formatDateTime(new Date("2026-10-22T01:05:00Z"))).toBe("2026/10/22 10:05");
  });
});

describe("buildHistory", () => {
  const observations = [
    { id: "o1", type: "leaves_new", value: 1, observed_at: "2026-10-01T00:00:00Z", superseded_by: null, observer_name: "太郎" },
    { id: "o2", type: "leaves_current", value: 8, observed_at: "2026-10-03T00:00:00Z", superseded_by: "o3", observer_name: null },
  ];
  const events = [
    { id: "e1", type: "leaves_removed", occurred_at: "2026-10-02T00:00:00Z", payload: { count: 2 }, superseded_by: null, recorder_name: "太郎" },
    { id: "e2", type: "bagged", occurred_at: "2026-10-01T00:00:00Z", payload: {}, superseded_by: null },
  ];

  it("観測とイベントを混ぜて新しい順に並べ、文言・記録者・訂正済みを付ける", () => {
    const h = buildHistory(observations, events);
    expect(h.map((x) => x.key)).toEqual(["observation:o2", "event:e1", "observation:o1", "event:e2"]);
    expect(h[0]).toMatchObject({ kind: "observation", label: "現在の葉数", valueText: "8 枚", by: null, superseded: true });
    expect(h[1]).toMatchObject({ kind: "event", label: "枯葉処理", valueText: "2 枚", by: "太郎", superseded: false });
    expect(h[2]).toMatchObject({ label: "新葉", valueText: "+1" });
    expect(h[3]).toMatchObject({ label: "袋掛け", valueText: "" });
  });

  it("空なら空", () => {
    expect(buildHistory([], [])).toEqual([]);
  });

  it("イベントのメモ（events.note）があれば付ける。なければ付けない（圃場・株の被害 2-5）", () => {
    const h = buildHistory(
      [],
      [
        { id: "d1", type: "damage", occurred_at: "2026-10-02T00:00:00Z", payload: { kind: "lodging", severity: "severe" }, superseded_by: null, note: "台風 14 号" },
        { id: "d2", type: "damage", occurred_at: "2026-10-01T00:00:00Z", payload: { kind: "cold", severity: "light" }, superseded_by: null, note: null },
      ],
    );
    expect(h[0]).toMatchObject({ label: "被害", valueText: "倒伏・重", note: "台風 14 号" });
    expect(h[1]).toMatchObject({ valueText: "寒害・軽" });
    expect("note" in h[1]).toBe(false);
  });

  it("同時刻は観測 → イベント → 写真の順", () => {
    const h = buildHistory(
      [{ id: "o", type: "leaves_new", value: 1, observed_at: "2026-10-01T00:00:00Z", superseded_by: null }],
      [{ id: "e", type: "bagged", occurred_at: "2026-10-01T00:00:00Z", payload: {}, superseded_by: null }],
      [{ id: "p", kind: "side", taken_at: "2026-10-01T00:00:00Z", url: null }],
    );
    expect(h.map((x) => x.kind)).toEqual(["observation", "event", "photo"]);
  });

  it("写真は撮影日時で時系列に入り、種類の文言・署名付き URL・撮影者を持つ", () => {
    const h = buildHistory(observations, events, [
      { id: "p1", kind: "side", taken_at: "2026-10-02T12:00:00Z", url: "https://example.test/p1.jpg", taker_name: "太郎" },
      { id: "p2", kind: "bud", taken_at: "2026-09-30T00:00:00Z", url: null },
    ]);
    expect(h.map((x) => x.key)).toEqual(["observation:o2", "photo:p1", "event:e1", "observation:o1", "event:e2", "photo:p2"]);
    expect(h[1]).toMatchObject({
      kind: "photo",
      type: "side",
      label: "写真",
      valueText: "横から",
      by: "太郎",
      superseded: false,
      photo: { id: "p1", url: "https://example.test/p1.jpg", kind: "side" },
    });
    expect(h[5]).toMatchObject({ kind: "photo", valueText: "蕾", by: null, photo: { url: null } });
    // 観測・イベントには photo が付かない
    expect(h[0].photo).toBeUndefined();
  });
});

describe("累計・検算の入力への変換", () => {
  it("訂正済み（superseded_by あり）と葉以外の観測は除く", () => {
    const obs = toLeafObservations([
      { id: "1", type: "leaves_new", value: 1, observed_at: "2026-10-01T00:00:00Z", superseded_by: null },
      { id: "2", type: "leaves_new", value: 5, observed_at: "2026-10-02T00:00:00Z", superseded_by: "3" },
      { id: "4", type: "height_cm", value: 120, observed_at: "2026-10-02T00:00:00Z", superseded_by: null },
      { id: "5", type: "leaves_current", value: 8, observed_at: "2026-10-03T00:00:00Z", superseded_by: null },
    ]);
    expect(obs).toEqual([
      { type: "leaves_new", value: 1, observedAt: new Date("2026-10-01T00:00:00Z"), id: "1" },
      { type: "leaves_current", value: 8, observedAt: new Date("2026-10-03T00:00:00Z"), id: "5" },
    ]);
  });

  it("枯葉処理イベントだけを count 付きで取り出す", () => {
    const removed = toLeavesRemoved([
      { id: "a", type: "leaves_removed", occurred_at: "2026-10-02T00:00:00Z", payload: { count: 2 }, superseded_by: null },
      { id: "b", type: "leaves_removed", occurred_at: "2026-10-03T00:00:00Z", payload: { count: 1 }, superseded_by: "c" },
      { id: "d", type: "bagged", occurred_at: "2026-10-04T00:00:00Z", payload: {}, superseded_by: null },
    ]);
    expect(removed).toEqual([{ count: 2, occurredAt: new Date("2026-10-02T00:00:00Z") }]);
  });
});
