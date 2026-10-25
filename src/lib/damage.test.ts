import { describe, expect, it } from "vitest";
import {
  bulkDamageCandidates,
  bulkDamageKey,
  bulkMatDamageRows,
  checkFieldDamageEvent,
  type FieldDamageEvent,
  isTargetDamageSeverity,
  LOST_REJECTED_MESSAGE,
  NO_TARGET_MESSAGE,
  parseDamageDate,
  parseDamageNote,
  parseTargetDamageSeverity,
  RELOAD_MESSAGE,
  selectedMatIds,
  TARGET_DAMAGE_SEVERITIES,
  targetDamageEventRow,
  targetDamageKey,
  validateBulkDamage,
  validateTargetDamage,
} from "./damage";
import { DAMAGE_SEVERITIES } from "./stemEvents";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const EV = "44444444-4444-4444-8444-444444444444";
const FIELD = "55555555-5555-4555-8555-555555555555";
const BATCH = "66666666-6666-4666-8666-666666666666";
// 2026-10-25 12:00 JST
const NOW = new Date("2026-10-25T03:00:00Z");

const input = (over: Partial<Parameters<typeof validateTargetDamage>[0]> = {}) => ({
  eventId: EV,
  targetType: "field",
  targetId: FIELD,
  date: "2026-10-24",
  kind: "lodging",
  severity: "severe",
  note: "  台風 14 号 ",
  ...over,
});

describe("程度の選択肢（喪失を除く）", () => {
  it("茎の被害の定義から lost だけを除き、順は同じ", () => {
    expect(TARGET_DAMAGE_SEVERITIES).toEqual(["light", "moderate", "severe"]);
    expect(TARGET_DAMAGE_SEVERITIES).toEqual(DAMAGE_SEVERITIES.filter((s) => s !== "lost"));
  });
  it("lost は圃場・株の程度ではない", () => {
    expect(isTargetDamageSeverity("lost")).toBe(false);
    expect(isTargetDamageSeverity("severe")).toBe(true);
    expect(isTargetDamageSeverity("other")).toBe(false);
    expect(isTargetDamageSeverity(1)).toBe(false);
  });
  it("lost は理由付きで拒否、空・不明は選んでください", () => {
    expect(parseTargetDamageSeverity("lost")).toEqual({ ok: false, error: LOST_REJECTED_MESSAGE });
    expect(parseTargetDamageSeverity("")).toEqual({ ok: false, error: "被害の程度を選んでください" });
    expect(parseTargetDamageSeverity("huge")).toEqual({ ok: false, error: "被害の程度を選んでください" });
    expect(parseTargetDamageSeverity(" light ")).toEqual({ ok: true, value: "light" });
  });
});

describe("入力の解釈", () => {
  it("日付: 形式違い・未来は拒否（日本時間）", () => {
    expect(parseDamageDate("2026-10-25", NOW)).toEqual({ ok: true, value: "2026-10-25" });
    expect(parseDamageDate("2026-10-26", NOW).ok).toBe(false);
    expect(parseDamageDate("2026/10/25", NOW).ok).toBe(false);
    expect(parseDamageDate("2026-02-30", NOW).ok).toBe(false);
  });
  it("メモ: 空は null、前後の空白を取る、200 文字まで", () => {
    expect(parseDamageNote("  ")).toEqual({ ok: true, value: null });
    expect(parseDamageNote(" 台風 ")).toEqual({ ok: true, value: "台風" });
    expect(parseDamageNote("あ".repeat(200)).ok).toBe(true);
    expect(parseDamageNote("あ".repeat(201)).ok).toBe(false);
  });
});

describe("validateTargetDamage", () => {
  it("正しい入力を整える", () => {
    expect(validateTargetDamage(input(), NOW)).toEqual({
      ok: true,
      value: {
        eventId: EV,
        targetType: "field",
        targetId: FIELD,
        date: "2026-10-24",
        kind: "lodging",
        severity: "severe",
        note: "台風 14 号",
      },
    });
    expect(validateTargetDamage(input({ targetType: "mat", targetId: U1, note: "" }), NOW)).toMatchObject({
      ok: true,
      value: { targetType: "mat", note: null },
    });
  });
  it("lost を送っても拒否される", () => {
    expect(validateTargetDamage(input({ severity: "lost" }), NOW)).toEqual({
      ok: false,
      errors: { severity: LOST_REJECTED_MESSAGE },
    });
  });
  it("項目ごとのエラーをまとめて返す", () => {
    const r = validateTargetDamage(input({ date: "2026-10-30", kind: "", severity: "", note: "x".repeat(201) }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["date", "kind", "note", "severity"]);
  });
  it("id が不正・対象の種類が stem などは再読み込みを促す", () => {
    expect(validateTargetDamage(input({ eventId: "x" }), NOW)).toEqual({ ok: false, errors: { form: RELOAD_MESSAGE } });
    expect(validateTargetDamage(input({ targetId: "x" }), NOW)).toEqual({ ok: false, errors: { form: RELOAD_MESSAGE } });
    expect(validateTargetDamage(input({ targetType: "stem" }), NOW)).toEqual({ ok: false, errors: { form: RELOAD_MESSAGE } });
  });
});

describe("targetDamageKey / targetDamageEventRow", () => {
  it("内容が同じなら同じ key（メモ・日付の前後の空白は無視）、変われば違う", () => {
    const base = { targetType: "field", targetId: FIELD, date: "2026-10-24", kind: "lodging", severity: "severe", note: "台風" };
    expect(targetDamageKey(base)).toBe(targetDamageKey({ ...base, note: " 台風 " }));
    expect(targetDamageKey(base)).not.toBe(targetDamageKey({ ...base, severity: "light" }));
    expect(targetDamageKey(base)).not.toBe(targetDamageKey({ ...base, note: "" }));
  });
  it("events の行: payload は {kind, severity}、メモは note、organization_id は渡さない", () => {
    const v = validateTargetDamage(input(), NOW);
    if (!v.ok) throw new Error("invalid");
    const row = targetDamageEventRow(v.value, "2026-10-23T15:00:00.000Z", U3);
    expect(row).toEqual({
      id: EV,
      type: "damage",
      target_type: "field",
      target_id: FIELD,
      occurred_at: "2026-10-23T15:00:00.000Z",
      recorded_by: U3,
      payload: { kind: "lodging", severity: "severe" },
      note: "台風 14 号",
    });
    expect("organization_id" in row).toBe(false);
  });
});

const fieldEvent = (over: Partial<FieldDamageEvent> = {}): FieldDamageEvent => ({
  id: EV,
  type: "damage",
  target_type: "field",
  target_id: FIELD,
  occurred_at: "2026-10-23T15:00:00.000Z",
  payload: { kind: "leaf_tear", severity: "moderate" },
  note: "台風",
  superseded_by: null,
  ...over,
});

describe("checkFieldDamageEvent", () => {
  it("その圃場の被害なら種類・程度を返す", () => {
    expect(checkFieldDamageEvent(fieldEvent(), FIELD)).toEqual({ ok: true, kind: "leaf_tear", severity: "moderate" });
  });
  it("ない・別の圃場・株の被害・別の種類のイベント・訂正済み・lost は使えない", () => {
    expect(checkFieldDamageEvent(null, FIELD).ok).toBe(false);
    expect(checkFieldDamageEvent(fieldEvent({ target_id: U1 }), FIELD).ok).toBe(false);
    expect(checkFieldDamageEvent(fieldEvent({ target_type: "mat" }), FIELD).ok).toBe(false);
    expect(checkFieldDamageEvent(fieldEvent({ type: "fertilized" }), FIELD).ok).toBe(false);
    expect(checkFieldDamageEvent(fieldEvent({ superseded_by: U2 }), FIELD).ok).toBe(false);
    expect(checkFieldDamageEvent(fieldEvent({ payload: { kind: "lodging", severity: "lost" } }), FIELD)).toEqual({
      ok: false,
      error: LOST_REJECTED_MESSAGE,
    });
    expect(checkFieldDamageEvent(fieldEvent({ payload: { kind: "x", severity: "light" } }), FIELD).ok).toBe(false);
  });
});

describe("一括の対象の抽出", () => {
  const mats = [
    { id: U1, code: "A-001", status: "active" },
    { id: U2, code: "A-002", status: "removed" },
    { id: U3, code: "A-003", status: "active" },
  ];
  it("撤去した株と、この圃場の被害から記録済みの株を除く（順はそのまま）", () => {
    expect(bulkDamageCandidates(mats, new Set()).map((m) => m.code)).toEqual(["A-001", "A-003"]);
    expect(bulkDamageCandidates(mats, new Set([U1])).map((m) => m.code)).toEqual(["A-003"]);
  });
  it("外した株を除いた対象（一覧の順）", () => {
    expect(selectedMatIds([U1, U2, U3], new Set())).toEqual([U1, U2, U3]);
    expect(selectedMatIds([U1, U2, U3], new Set([U2]))).toEqual([U1, U3]);
    expect(selectedMatIds([U1], new Set([U1]))).toEqual([]);
  });
});

describe("validateBulkDamage / bulkDamageKey", () => {
  const bulk = { batchId: BATCH, fieldId: FIELD, fieldEventId: EV, matIds: [U1, U3] };
  it("正しい入力", () => {
    expect(validateBulkDamage(bulk)).toEqual({ ok: true, value: bulk });
  });
  it("対象 0 株・重複・不正な id は拒否", () => {
    expect(validateBulkDamage({ ...bulk, matIds: [] })).toEqual({ ok: false, errors: { targets: NO_TARGET_MESSAGE } });
    expect(validateBulkDamage({ ...bulk, matIds: [U1, U1] })).toEqual({ ok: false, errors: { targets: RELOAD_MESSAGE } });
    expect(validateBulkDamage({ ...bulk, matIds: ["x"] })).toEqual({ ok: false, errors: { targets: RELOAD_MESSAGE } });
    expect(validateBulkDamage({ ...bulk, batchId: "x" })).toEqual({ ok: false, errors: { form: RELOAD_MESSAGE } });
    expect(validateBulkDamage({ ...bulk, fieldEventId: "x" })).toEqual({ ok: false, errors: { form: RELOAD_MESSAGE } });
  });
  it("対象が同じなら同じ key、変われば違う", () => {
    const k = bulkDamageKey(bulk);
    expect(bulkDamageKey({ ...bulk })).toBe(k);
    expect(bulkDamageKey({ ...bulk, matIds: [U1] })).not.toBe(k);
  });
});

describe("bulkMatDamageRows", () => {
  it("株ごとに同じ日付・種類・程度・メモ。payload に field_event_id と batch_id。organization_id は渡さない", () => {
    const rows = bulkMatDamageRows(fieldEvent(), { kind: "leaf_tear", severity: "moderate" }, [U1, U3], BATCH, U2);
    expect(rows).toEqual(
      [U1, U3].map((id) => ({
        type: "damage",
        target_type: "mat",
        target_id: id,
        occurred_at: "2026-10-23T15:00:00.000Z",
        recorded_by: U2,
        payload: { kind: "leaf_tear", severity: "moderate", field_event_id: EV, batch_id: BATCH },
        note: "台風",
      })),
    );
    for (const r of rows) expect("organization_id" in r).toBe(false);
  });
});
