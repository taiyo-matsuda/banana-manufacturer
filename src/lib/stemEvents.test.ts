import { describe, expect, it } from "vitest";
import {
  allowedEventTypes,
  canRecordEvent,
  DAMAGE_KINDS,
  DAMAGE_SEVERITIES,
  damageKindLabel,
  damageSeverityLabel,
  latestDateJst,
  nextStatus,
  occurredAtFromDate,
  parseEventInput,
  STEM_EVENT_TYPES,
  stemEventLabel,
  stemEventValueText,
  todayJst,
} from "./stemEvents";

const ALL_STATUSES = ["sucker", "active", "flowered", "harvested", "removed", "transplanted", "lost"];

// 0008_record_stem_event.sql と同じ表
describe("canRecordEvent / allowedEventTypes（状態ごとに記録できるイベント）", () => {
  it("active: 出蕾と被害だけ（袋掛けなどは出蕾前にはできない）", () => {
    expect(allowedEventTypes("active")).toEqual(["bud_emerged", "damage"]);
    expect(canRecordEvent("active", "bagged")).toBe(false);
    expect(canRecordEvent("active", "harvested")).toBe(false);
  });

  it("flowered: 段数・袋掛け・摘蕾・収穫・被害（出蕾はもうできない）", () => {
    expect(allowedEventTypes("flowered")).toEqual(["hands_counted", "bagged", "debudded", "harvested", "damage"]);
    expect(canRecordEvent("flowered", "bud_emerged")).toBe(false);
  });

  it("それ以外の状態（収穫済み・喪失・吸芽など）では何も記録できない", () => {
    for (const s of ["sucker", "harvested", "removed", "transplanted", "lost"]) {
      expect(allowedEventTypes(s)).toEqual([]);
      for (const t of STEM_EVENT_TYPES) expect(canRecordEvent(s, t)).toBe(false);
    }
  });

  it("この画面で扱わないイベント（枯葉処理・施肥・吸芽系）は false", () => {
    for (const s of ALL_STATUSES) {
      expect(canRecordEvent(s, "leaves_removed")).toBe(false);
      expect(canRecordEvent(s, "fertilized")).toBe(false);
      expect(canRecordEvent(s, "sucker_emerged")).toBe(false);
    }
  });
});

describe("nextStatus（イベントで状態がどう変わるか）", () => {
  it("出蕾 → flowered、収穫 → harvested", () => {
    expect(nextStatus("active", "bud_emerged")).toBe("flowered");
    expect(nextStatus("flowered", "harvested")).toBe("harvested");
  });
  it("段数・袋掛け・摘蕾は状態を変えない", () => {
    expect(nextStatus("flowered", "hands_counted", { hands: 8 })).toBe("flowered");
    expect(nextStatus("flowered", "bagged")).toBe("flowered");
    expect(nextStatus("flowered", "debudded")).toBe("flowered");
  });
  it("被害は喪失（lost）のときだけ lost。それ以外は変えない", () => {
    expect(nextStatus("active", "damage", { kind: "lodging", severity: "lost" })).toBe("lost");
    expect(nextStatus("flowered", "damage", { kind: "cold", severity: "lost" })).toBe("lost");
    expect(nextStatus("active", "damage", { kind: "lodging", severity: "light" })).toBe("active");
    expect(nextStatus("flowered", "damage", { kind: "break", severity: "severe" })).toBe("flowered");
  });
  it("記録できない組み合わせは null", () => {
    expect(nextStatus("active", "bagged")).toBeNull();
    expect(nextStatus("harvested", "damage", { severity: "lost" })).toBeNull();
    expect(nextStatus("active", "leaves_removed")).toBeNull();
  });
});

describe("文言", () => {
  it("イベント・被害の種類・程度に日本語がある", () => {
    expect(stemEventLabel("bud_emerged")).toBe("出蕾");
    expect(stemEventLabel("hands_counted")).toBe("段数");
    expect(stemEventLabel("harvested")).toBe("収穫");
    expect(stemEventLabel("unknown")).toBe("unknown");
    expect(DAMAGE_KINDS.map(damageKindLabel)).toEqual(["倒伏", "裂葉", "折損", "寒害", "病害"]);
    expect(DAMAGE_SEVERITIES.map(damageSeverityLabel)).toEqual(["軽", "中", "重", "喪失"]);
    expect(damageKindLabel(undefined)).toBe("");
  });

  it("履歴の要点: 出蕾は累計葉数・生葉数・周囲長、段数、収穫は重量、被害は種類・程度", () => {
    expect(stemEventValueText("bud_emerged", { cumulative_leaves: 12, leaves_current: 10, girth_cm: 45.5, earliest_at: "2026-10-15" })).toBe(
      "累計葉数 12 枚・生葉数 10 枚・周囲長 45.5 cm",
    );
    expect(stemEventValueText("bud_emerged", { cumulative_leaves: 12 })).toBe("累計葉数 12 枚");
    expect(stemEventValueText("hands_counted", { hands: 8 })).toBe("8 段");
    expect(stemEventValueText("harvested", { weight_kg: 12.5 })).toBe("12.5 kg");
    expect(stemEventValueText("damage", { kind: "lodging", severity: "light" })).toBe("倒伏・軽");
    expect(stemEventValueText("damage", { kind: "cold", severity: "lost" })).toBe("寒害・喪失");
    expect(stemEventValueText("bagged", {})).toBe("");
    expect(stemEventValueText("debudded", null)).toBe("");
  });
});

describe("日付", () => {
  it("todayJst は日本時間の日付", () => {
    expect(todayJst(new Date("2026-10-21T16:00:00Z"))).toBe("2026-10-22"); // JST 01:00
    expect(todayJst(new Date("2026-10-21T14:59:00Z"))).toBe("2026-10-21");
  });

  it("occurredAtFromDate: 今日なら今の時刻、過去日ならその日の 0:00 JST", () => {
    const now = new Date("2026-10-22T03:04:05Z"); // JST 12:04
    expect(occurredAtFromDate("2026-10-22", now)).toBe("2026-10-22T03:04:05.000Z");
    expect(occurredAtFromDate("2026-10-20", now)).toBe("2026-10-19T15:00:00.000Z");
  });

  it("latestDateJst: 直近の日時を日本時間の日付に。なければ null", () => {
    expect(latestDateJst(["2026-10-01T00:00:00Z", new Date("2026-10-15T20:00:00Z"), "2026-10-10T00:00:00Z"])).toBe("2026-10-16");
    expect(latestDateJst([])).toBeNull();
    expect(latestDateJst(["not a date"])).toBeNull();
  });
});

describe("parseEventInput", () => {
  it("出蕾: 確認日・前回訪問日（任意）・生葉数（整数 ≥ 0）・周囲長（> 0）", () => {
    expect(
      parseEventInput({ type: "bud_emerged", date: "2026-10-22", earliestAt: "2026-10-15", leavesCurrent: "10", girthCm: "45.5" }),
    ).toEqual({
      ok: true,
      value: { type: "bud_emerged", date: "2026-10-22", payload: { leaves_current: 10, girth_cm: 45.5, earliest_at: "2026-10-15" } },
    });
    // 前回訪問日は空でもよい（null）
    const r = parseEventInput({ type: "bud_emerged", date: "2026-10-22", earliestAt: "", leavesCurrent: "0", girthCm: "30" });
    expect(r.ok && r.value.payload).toEqual({ leaves_current: 0, girth_cm: 30, earliest_at: null });
    expect(parseEventInput({ type: "bud_emerged", date: "2026-10-22", leavesCurrent: "", girthCm: "30" })).toEqual({
      ok: false,
      error: "生葉数を入力してください",
    });
    expect(parseEventInput({ type: "bud_emerged", date: "2026-10-22", leavesCurrent: "-1", girthCm: "30" }).ok).toBe(false);
    expect(parseEventInput({ type: "bud_emerged", date: "2026-10-22", leavesCurrent: "10", girthCm: "0" })).toEqual({
      ok: false,
      error: "偽茎周囲長は 0 より大きい数（小数 1 桁まで）で入力してください",
    });
    expect(parseEventInput({ type: "bud_emerged", date: "2026-10-22", leavesCurrent: "10", girthCm: "45.55" }).ok).toBe(false);
    expect(parseEventInput({ type: "bud_emerged", date: "2026-10-22", earliestAt: "2026-10-23", leavesCurrent: "10", girthCm: "45" })).toEqual({
      ok: false,
      error: "前回訪問日は確認日より前の日付にしてください",
    });
  });

  it("段数は 1 以上の整数", () => {
    expect(parseEventInput({ type: "hands_counted", date: "2026-10-22", hands: "8" })).toEqual({
      ok: true,
      value: { type: "hands_counted", date: "2026-10-22", payload: { hands: 8 } },
    });
    expect(parseEventInput({ type: "hands_counted", date: "2026-10-22", hands: "0" })).toEqual({
      ok: false,
      error: "段数は 1 以上の整数で入力してください",
    });
  });

  it("袋掛け・摘蕾は日付だけ（payload は {}）", () => {
    expect(parseEventInput({ type: "bagged", date: "2026-10-22" })).toEqual({ ok: true, value: { type: "bagged", date: "2026-10-22", payload: {} } });
    expect(parseEventInput({ type: "debudded", date: "2026-10-22" })).toEqual({ ok: true, value: { type: "debudded", date: "2026-10-22", payload: {} } });
  });

  it("収穫は果房重量 kg（小数 1 桁、0 より大きい）", () => {
    expect(parseEventInput({ type: "harvested", date: "2026-10-22", weightKg: "12.5" })).toEqual({
      ok: true,
      value: { type: "harvested", date: "2026-10-22", payload: { weight_kg: 12.5 } },
    });
    expect(parseEventInput({ type: "harvested", date: "2026-10-22", weightKg: "12" }).ok).toBe(true);
    expect(parseEventInput({ type: "harvested", date: "2026-10-22", weightKg: "0" }).ok).toBe(false);
    expect(parseEventInput({ type: "harvested", date: "2026-10-22", weightKg: "12.55" }).ok).toBe(false);
    expect(parseEventInput({ type: "harvested", date: "2026-10-22", weightKg: "" })).toEqual({ ok: false, error: "果房重量を入力してください" });
  });

  it("被害は種類と程度", () => {
    expect(parseEventInput({ type: "damage", date: "2026-10-22", kind: "lodging", severity: "lost" })).toEqual({
      ok: true,
      value: { type: "damage", date: "2026-10-22", payload: { kind: "lodging", severity: "lost" } },
    });
    expect(parseEventInput({ type: "damage", date: "2026-10-22", kind: "typhoon", severity: "lost" })).toEqual({
      ok: false,
      error: "被害の種類を選んでください",
    });
    expect(parseEventInput({ type: "damage", date: "2026-10-22", kind: "lodging", severity: "" })).toEqual({
      ok: false,
      error: "被害の程度を選んでください",
    });
  });

  it("日付が不正、または扱わないイベントは拒否", () => {
    expect(parseEventInput({ type: "bagged", date: "2026/10/22" })).toEqual({ ok: false, error: "日付を YYYY-MM-DD で入力してください" });
    expect(parseEventInput({ type: "bagged", date: "" }).ok).toBe(false);
    expect(parseEventInput({ type: "leaves_removed", date: "2026-10-22" })).toEqual({ ok: false, error: "記録するイベントを選んでください" });
  });
});
