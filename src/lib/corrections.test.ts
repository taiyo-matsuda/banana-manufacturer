import { describe, expect, it } from "vitest";
import {
  ALREADY_CORRECTED_MESSAGE,
  budLeafSnapshot,
  budLeafSnapshotText,
  correctableSeverities,
  correctedTimestamp,
  correctionAvailability,
  correctionKey,
  type CorrectionOriginal,
  damageSeverityChangeError,
  FUTURE_DATE_MESSAGE,
  initialCorrectionForm,
  isCorrectableType,
  LOST_SEVERITY_FORBIDDEN_MESSAGE,
  LOST_SEVERITY_LOCKED_MESSAGE,
  NO_CHANGE_MESSAGE,
  OFFLINE_CORRECTION_MESSAGE,
  parseEventCorrection,
  parseObservationCorrection,
  PENDING_CORRECTION_MESSAGE,
} from "./corrections";
import { buildHistory, type EventRow, type ObservationRow, toLeafObservations } from "./stems/records";
import { cumulativeLeaves } from "./leaves";

const NOW = new Date("2026-10-25T03:00:00Z"); // 2026-10-25 12:00 JST

describe("isCorrectableType", () => {
  it("茎の観測 4 種類と茎のイベント 7 種類だけ訂正できる", () => {
    for (const t of ["leaves_new", "leaves_current", "pseudostem_girth_cm", "height_cm"]) {
      expect(isCorrectableType("observation", t)).toBe(true);
    }
    for (const t of ["bud_emerged", "hands_counted", "bagged", "debudded", "harvested", "leaves_removed", "damage"]) {
      expect(isCorrectableType("event", t)).toBe(true);
    }
    for (const t of ["sucker_emerged", "sucker_adopted", "sucker_removed", "sucker_transplanted", "fertilized", "mat_removed"]) {
      expect(isCorrectableType("event", t)).toBe(false);
    }
    expect(isCorrectableType("photo", "stem_side")).toBe(false);
  });
});

describe("correctionAvailability", () => {
  const base = { targetType: "stem" as const, kind: "observation" as const, type: "leaves_new", superseded: false, pending: false };
  it("オンラインで訂正済みでも未同期でもなければ押せる", () => {
    expect(correctionAvailability(base, true)).toEqual({ show: true, enabled: true });
  });
  it("訂正済みの行と対象外の種類にはボタンを出さない", () => {
    expect(correctionAvailability({ ...base, superseded: true }, true)).toEqual({ show: false });
    expect(correctionAvailability({ ...base, kind: "event", type: "sucker_emerged" }, true)).toEqual({ show: false });
    expect(correctionAvailability({ ...base, kind: "photo", type: "stem_side" }, true)).toEqual({ show: false });
  });
  it("圃場・株の記録（被害など）には茎と同じ種類でもボタンを出さない", () => {
    expect(correctionAvailability({ ...base, targetType: "field", kind: "event", type: "damage" }, true)).toEqual({ show: false });
    expect(correctionAvailability({ ...base, targetType: "mat", kind: "event", type: "damage" }, true)).toEqual({ show: false });
  });
  it("未同期の行は「同期してから」、圏外は理由付きで押せない", () => {
    expect(correctionAvailability({ ...base, pending: true }, true)).toEqual({
      show: true,
      enabled: false,
      reason: PENDING_CORRECTION_MESSAGE,
    });
    expect(correctionAvailability(base, false)).toEqual({ show: true, enabled: false, reason: OFFLINE_CORRECTION_MESSAGE });
  });
  it("RPC と同じ「すでに訂正」の文言", () => {
    expect(ALREADY_CORRECTED_MESSAGE).toBe("この記録はすでに訂正されています。最新の記録を訂正してください");
  });
});

const leafObs: CorrectionOriginal = { kind: "observation", type: "leaves_new", at: "2026-10-20T01:00:00Z", value: 1 };

describe("initialCorrectionForm", () => {
  it("観測は元の値と日付（JST）を初期値にする", () => {
    expect(initialCorrectionForm(leafObs)).toMatchObject({ date: "2026-10-20", value: "1" });
  });
  it("イベントは payload の項目を初期値にする", () => {
    const f = initialCorrectionForm({
      kind: "event",
      type: "bud_emerged",
      at: "2026-10-19T15:30:00Z", // 2026-10-20 00:30 JST
      payload: { cumulative_leaves: 7, leaves_current: 10, girth_cm: 45.5, earliest_at: null },
    });
    expect(f).toMatchObject({ date: "2026-10-20", leavesCurrent: "10", girthCm: "45.5", earliestAt: "" });
    expect(initialCorrectionForm({ kind: "event", type: "harvested", at: leafObs.at, payload: { weight_kg: 12.3 } }).weightKg).toBe("12.3");
  });
});

describe("parseObservationCorrection", () => {
  const form = (patch: Partial<ReturnType<typeof initialCorrectionForm>>) => ({ ...initialCorrectionForm(leafObs), ...patch });
  it("+1 → +2 の訂正を受け付ける", () => {
    expect(parseObservationCorrection(leafObs, form({ value: "2" }), NOW)).toEqual({ ok: true, value: { date: "2026-10-20", value: 2 } });
  });
  it("日付だけの訂正も受け付ける", () => {
    expect(parseObservationCorrection(leafObs, form({ date: "2026-10-18" }), NOW)).toEqual({
      ok: true,
      value: { date: "2026-10-18", value: 1 },
    });
  });
  it("元と同じ・未来の日付・不正な値は拒否", () => {
    expect(parseObservationCorrection(leafObs, form({}), NOW)).toEqual({ ok: false, error: NO_CHANGE_MESSAGE });
    expect(parseObservationCorrection(leafObs, form({ date: "2026-10-26", value: "2" }), NOW)).toEqual({ ok: false, error: FUTURE_DATE_MESSAGE });
    expect(parseObservationCorrection(leafObs, form({ value: "-1" }), NOW).ok).toBe(false);
    expect(parseObservationCorrection(leafObs, form({ value: "1.5" }), NOW).ok).toBe(false);
    expect(parseObservationCorrection(leafObs, form({ value: "" }), NOW).ok).toBe(false);
  });
  it("周囲長は小数 1 桁まで、0 より大きい", () => {
    const girth: CorrectionOriginal = { kind: "observation", type: "pseudostem_girth_cm", at: leafObs.at, value: 45 };
    const f = initialCorrectionForm(girth);
    expect(parseObservationCorrection(girth, { ...f, value: "45.5" }, NOW)).toEqual({ ok: true, value: { date: "2026-10-20", value: 45.5 } });
    expect(parseObservationCorrection(girth, { ...f, value: "0" }, NOW).ok).toBe(false);
    expect(parseObservationCorrection(girth, { ...f, value: "45.55" }, NOW).ok).toBe(false);
  });
  it("対象外の種類は拒否", () => {
    expect(parseObservationCorrection({ ...leafObs, type: "other" }, form({ value: "2" }), NOW).ok).toBe(false);
  });
});

describe("parseEventCorrection", () => {
  const harvest: CorrectionOriginal = { kind: "event", type: "harvested", at: "2026-10-20T01:00:00Z", payload: { weight_kg: 12.3 } };
  it("収穫の重量の訂正。payload は訂正できる項目だけ", () => {
    const f = { ...initialCorrectionForm(harvest), weightKg: "13.5" };
    expect(parseEventCorrection(harvest, f, NOW)).toEqual({ ok: true, value: { date: "2026-10-20", payload: { weight_kg: 13.5 } } });
    expect(parseEventCorrection(harvest, initialCorrectionForm(harvest), NOW)).toEqual({ ok: false, error: NO_CHANGE_MESSAGE });
    expect(parseEventCorrection(harvest, { ...f, weightKg: "0" }, NOW).ok).toBe(false);
  });
  it("出蕾は生葉数・周囲長・前回訪問日・日付を直せる（cumulative_leaves は payload に入れない）", () => {
    const bud: CorrectionOriginal = {
      kind: "event",
      type: "bud_emerged",
      at: "2026-10-20T01:00:00Z",
      payload: { cumulative_leaves: 7, leaves_current: 10, girth_cm: 45.5, earliest_at: null },
    };
    const f = initialCorrectionForm(bud);
    expect(parseEventCorrection(bud, f, NOW)).toEqual({ ok: false, error: NO_CHANGE_MESSAGE });
    const r = parseEventCorrection(bud, { ...f, date: "2026-10-18", earliestAt: "2026-10-11" }, NOW);
    expect(r).toEqual({
      ok: true,
      value: { date: "2026-10-18", payload: { leaves_current: 10, girth_cm: 45.5, earliest_at: "2026-10-11" } },
    });
    expect(parseEventCorrection(bud, { ...f, earliestAt: "2026-10-21" }, NOW).ok).toBe(false);
  });
  it("袋掛けは日付だけ", () => {
    const bagged: CorrectionOriginal = { kind: "event", type: "bagged", at: "2026-10-20T01:00:00Z", payload: {} };
    const f = initialCorrectionForm(bagged);
    expect(parseEventCorrection(bagged, f, NOW)).toEqual({ ok: false, error: NO_CHANGE_MESSAGE });
    expect(parseEventCorrection(bagged, { ...f, date: "2026-10-19" }, NOW)).toEqual({ ok: true, value: { date: "2026-10-19", payload: {} } });
  });
  it("枯葉処理の枚数（1 以上）", () => {
    const removed: CorrectionOriginal = { kind: "event", type: "leaves_removed", at: "2026-10-20T01:00:00Z", payload: { count: 2 } };
    const f = initialCorrectionForm(removed);
    expect(parseEventCorrection(removed, { ...f, count: "3" }, NOW)).toEqual({ ok: true, value: { date: "2026-10-20", payload: { count: 3 } } });
    expect(parseEventCorrection(removed, { ...f, count: "0" }, NOW).ok).toBe(false);
  });
  it("被害: 喪失のまま日付・種類は直せる。喪失 ⇔ 喪失以外は拒否", () => {
    const lost: CorrectionOriginal = { kind: "event", type: "damage", at: "2026-10-20T01:00:00Z", payload: { kind: "lodging", severity: "lost" } };
    const f = initialCorrectionForm(lost);
    expect(parseEventCorrection(lost, { ...f, kind: "break" }, NOW)).toEqual({
      ok: true,
      value: { date: "2026-10-20", payload: { kind: "break", severity: "lost" } },
    });
    expect(parseEventCorrection(lost, { ...f, severity: "severe" }, NOW)).toEqual({ ok: false, error: LOST_SEVERITY_LOCKED_MESSAGE });
    const light: CorrectionOriginal = { ...lost, payload: { kind: "lodging", severity: "light" } };
    const g = initialCorrectionForm(light);
    expect(parseEventCorrection(light, { ...g, severity: "severe" }, NOW).ok).toBe(true);
    expect(parseEventCorrection(light, { ...g, severity: "lost" }, NOW)).toEqual({ ok: false, error: LOST_SEVERITY_FORBIDDEN_MESSAGE });
  });
  it("対象外の種類は拒否", () => {
    expect(parseEventCorrection({ ...harvest, type: "fertilized" }, initialCorrectionForm(harvest), NOW).ok).toBe(false);
  });
});

describe("damageSeverityChangeError / correctableSeverities", () => {
  it("喪失は喪失だけ、それ以外は喪失を除く", () => {
    expect(correctableSeverities("lost")).toEqual(["lost"]);
    expect(correctableSeverities("light")).toEqual(["light", "moderate", "severe"]);
    expect(damageSeverityChangeError("lost", "lost")).toBeNull();
    expect(damageSeverityChangeError("light", "severe")).toBeNull();
    expect(damageSeverityChangeError("lost", "light")).toBe(LOST_SEVERITY_LOCKED_MESSAGE);
    expect(damageSeverityChangeError("moderate", "lost")).toBe(LOST_SEVERITY_FORBIDDEN_MESSAGE);
  });
});

describe("correctedTimestamp / correctionKey", () => {
  it("日付を変えなければ元の時刻のまま、変えたら記録と同じ規則", () => {
    expect(correctedTimestamp("2026-10-20", "2026-10-20T01:23:45.000Z", NOW)).toBe("2026-10-20T01:23:45.000Z");
    expect(correctedTimestamp("2026-10-18", "2026-10-20T01:23:45.000Z", NOW)).toBe("2026-10-17T15:00:00.000Z");
    expect(correctedTimestamp("2026-10-25", "2026-10-20T01:23:45.000Z", NOW)).toBe(NOW.toISOString());
  });
  it("同じ内容なら同じ鍵、内容が変われば別の鍵", () => {
    const o = { ...leafObs, id: "o1" };
    expect(correctionKey(o, { value: 2 })).toBe(correctionKey(o, { value: 2 }));
    expect(correctionKey(o, { value: 2 })).not.toBe(correctionKey(o, { value: 3 }));
  });
});

// 訂正後の計算（superseded_by を除く）と履歴の表示
const obs = (id: string, value: number, observed_at: string, superseded_by: string | null = null): ObservationRow => ({
  id,
  type: "leaves_new",
  value,
  observed_at,
  superseded_by,
});

describe("訂正後の累計葉数と履歴", () => {
  it("+1 を +2 に訂正すると累計が 1 増え、元の行は訂正済み → +2、新しい行には訂正の印", () => {
    const before = [obs("a", 1, "2026-10-20T01:00:00Z")];
    expect(cumulativeLeaves(5, toLeafObservations(before))).toBe(6);
    const after = [obs("a", 1, "2026-10-20T01:00:00Z", "b"), obs("b", 2, "2026-10-20T01:00:00Z")];
    expect(cumulativeLeaves(5, toLeafObservations(after))).toBe(7);

    const history = buildHistory(after, []);
    const a = history.find((h) => h.id === "a")!;
    const b = history.find((h) => h.id === "b")!;
    expect(a).toMatchObject({ superseded: true, correctedTo: "+2", isCorrection: false, valueText: "+1" });
    expect(b).toMatchObject({ superseded: false, correctedTo: null, isCorrection: true, valueText: "+2" });
  });
  it("日付を変えた訂正は新しい日付も添える。値のないイベントは日付だけ", () => {
    const events: EventRow[] = [
      { id: "e1", type: "bagged", occurred_at: "2026-10-20T01:00:00Z", payload: {}, superseded_by: "e2" },
      { id: "e2", type: "bagged", occurred_at: "2026-10-18T15:00:00Z", payload: {}, superseded_by: null },
      { id: "h1", type: "harvested", occurred_at: "2026-10-20T01:00:00Z", payload: { weight_kg: 12 }, superseded_by: "h2" },
      { id: "h2", type: "harvested", occurred_at: "2026-10-18T15:00:00Z", payload: { weight_kg: 13.5 }, superseded_by: null },
    ];
    const history = buildHistory([], events);
    expect(history.find((h) => h.id === "e1")!.correctedTo).toBe("2026-10-19");
    expect(history.find((h) => h.id === "h1")!.correctedTo).toBe("13.5 kg（2026-10-19）");
  });
});

describe("budLeafSnapshot", () => {
  const bud = (payload: Record<string, unknown>, superseded_by: string | null = null): EventRow => ({
    id: "bud",
    type: "bud_emerged",
    occurred_at: "2026-10-22T03:00:00Z",
    payload,
    superseded_by,
  });
  it("出蕾より前の +1 を +2 に訂正すると記録と計算が食い違う", () => {
    const observations = [obs("a", 1, "2026-10-20T01:00:00Z", "b"), obs("b", 2, "2026-10-20T01:00:00Z")];
    const s = budLeafSnapshot(5, observations, [bud({ cumulative_leaves: 6 })]);
    expect(s).toEqual({ recorded: 6, computed: 7 });
    expect(budLeafSnapshotText(s)).toBe("出蕾時の累計葉数（記録）6 枚 / 現在の計算 7 枚");
  });
  it("一致していれば文言は出さない。出蕾後の葉は数えない。出蕾がなければ null", () => {
    const observations = [obs("a", 1, "2026-10-20T01:00:00Z"), obs("c", 1, "2026-10-24T01:00:00Z")];
    const s = budLeafSnapshot(5, observations, [bud({ cumulative_leaves: 6 })]);
    expect(s).toEqual({ recorded: 6, computed: 6 });
    expect(budLeafSnapshotText(s)).toBeNull();
    expect(budLeafSnapshot(5, observations, [])).toBeNull();
    expect(budLeafSnapshot(5, observations, [bud({ cumulative_leaves: 6 }, "x")])).toBeNull();
    expect(budLeafSnapshot(5, observations, [bud({})])).toBeNull();
  });
});

describe("履歴の並び（訂正）", () => {
  it("日付を変えない訂正で新旧が同じ時刻なら、訂正で追加された行が上（連鎖も新しい順）", () => {
    const at = "2026-10-20T01:00:00Z";
    // id の辞書順では元の行が上に来る並びにしておく
    const observations = [obs("a", 1, at, "z"), obs("z", 2, at, "m"), obs("m", 3, at)];
    expect(buildHistory(observations, []).map((h) => h.id)).toEqual(["m", "z", "a"]);
    const events: EventRow[] = [
      { id: "a", type: "harvested", occurred_at: at, payload: { weight_kg: 12 }, superseded_by: "b" },
      { id: "b", type: "harvested", occurred_at: at, payload: { weight_kg: 13 }, superseded_by: null },
    ];
    expect(buildHistory([], events).map((h) => h.id)).toEqual(["b", "a"]);
  });
});
