import { describe, expect, it } from "vitest";
import { evaluateStemRecommendations, type ExistingRecommendation } from "./evaluate";
import { STEM_RULES, type StemEventFact, type StemFacts } from "./rules";
import { DEFAULT_RECOMMENDATION_SETTINGS } from "./settings";

const TODAY = "2026-10-28";
const USER = "11111111-1111-4111-8111-111111111111";

function stem(over: Partial<StemFacts> = {}): StemFacts {
  return {
    stemId: "s1",
    status: "flowered",
    budEmergedAt: "2026-10-14", // 14 日前
    events: [],
    harvestLowerDate: null,
    settings: DEFAULT_RECOMMENDATION_SETTINGS,
    ...over,
  };
}
const ev = (type: string, date = TODAY, over: Partial<StemEventFact> = {}): StemEventFact => ({
  id: `e-${type}`,
  type,
  date,
  recordedBy: USER,
  ...over,
});
const rec = (kind: string, status: string, over: Partial<ExistingRecommendation> = {}): ExistingRecommendation => ({
  id: `r-${kind}-${status}`,
  kind,
  targetType: "stem",
  targetId: "s1",
  ruleKey: "",
  status,
  ...over,
});

describe("袋掛け・摘蕾（出蕾から N 日）", () => {
  it("出蕾からちょうど N 日（14 日）で袋掛けと摘蕾の 2 件を作る。期限は出蕾日 + N、理由に N", () => {
    const r = evaluateStemRecommendations([stem()], [], TODAY);
    expect(r.resolve).toEqual([]);
    expect(r.create).toEqual([
      { kind: "bag", targetType: "stem", targetId: "s1", ruleKey: "", dueAt: TODAY, reason: "出蕾から 14 日（出蕾 10月14日）" },
      { kind: "debud", targetType: "stem", targetId: "s1", ruleKey: "", dueAt: TODAY, reason: "出蕾から 14 日（出蕾 10月14日）" },
    ]);
  });

  it("N 日に満たなければ作らない（13 日目）", () => {
    expect(evaluateStemRecommendations([stem({ budEmergedAt: "2026-10-15" })], [], TODAY).create).toEqual([]);
  });

  it("N は圃場の設定（7 日なら 7 日目で出る。期限は出蕾日 + 7）", () => {
    const s = stem({ budEmergedAt: "2026-10-21", settings: { ...DEFAULT_RECOMMENDATION_SETTINGS, bagAfterDays: 7 } });
    const r = evaluateStemRecommendations([s], [], TODAY);
    expect(r.create.map((c) => [c.kind, c.dueAt, c.reason])).toEqual([
      ["bag", TODAY, "出蕾から 7 日（出蕾 10月21日）"],
      ["debud", TODAY, "出蕾から 7 日（出蕾 10月21日）"],
    ]);
  });

  it("期限を過ぎていても（出蕾から 30 日）作る。期限は出蕾日 + N のまま", () => {
    const r = evaluateStemRecommendations([stem({ budEmergedAt: "2026-09-28" })], [], TODAY);
    expect(r.create.map((c) => c.dueAt)).toEqual(["2026-10-12", "2026-10-12"]);
  });

  it("袋掛けが記録済みなら袋掛けは作らない（摘蕾だけ）", () => {
    const r = evaluateStemRecommendations([stem({ events: [ev("bagged", "2026-10-20")] })], [], TODAY);
    expect(r.create.map((c) => c.kind)).toEqual(["debud"]);
  });

  it("出蕾前・終了した茎には作らない", () => {
    for (const status of ["active", "harvested", "lost", "removed", "transplanted"]) {
      expect(evaluateStemRecommendations([stem({ status })], [], TODAY).create).toEqual([]);
    }
    expect(evaluateStemRecommendations([stem({ budEmergedAt: null })], [], TODAY).create).toEqual([]);
  });

  it("open の袋掛けがあり、袋掛けが記録されたら done（記録したユーザーとイベントを残す）。摘蕾の open はそのまま", () => {
    const bagged = ev("bagged", TODAY, { id: "e-bag" });
    const r = evaluateStemRecommendations([stem({ events: [bagged] })], [rec("bag", "open"), rec("debud", "open")], TODAY);
    expect(r.resolve).toEqual([{ id: "r-bag-open", status: "done", note: "袋掛けを記録", resolvedBy: USER, eventId: "e-bag" }]);
    expect(r.create).toEqual([]);
  });

  it("摘蕾の記録で摘蕾の提案が done", () => {
    const r = evaluateStemRecommendations([stem({ events: [ev("debudded")] })], [rec("debud", "open")], TODAY);
    expect(r.resolve).toEqual([expect.objectContaining({ id: "r-debud-open", status: "done", note: "摘蕾を記録" })]);
  });
});

describe("収穫期（予測の下限が 7 日以内）", () => {
  it("下限が今日 + 7 日なら作る。期限は下限の日", () => {
    const r = evaluateStemRecommendations([stem({ budEmergedAt: "2026-10-20", harvestLowerDate: "2026-11-04" })], [], TODAY);
    expect(r.create).toEqual([
      {
        kind: "harvest_window",
        targetType: "stem",
        targetId: "s1",
        ruleKey: "",
        dueAt: "2026-11-04",
        reason: "積算温度が目安に近づいています（収穫予測の早い日 11月4日）",
      },
    ]);
  });

  it("下限が今日 + 8 日なら作らない。下限が過去でも作る", () => {
    const base = { budEmergedAt: "2026-10-20" };
    expect(evaluateStemRecommendations([stem({ ...base, harvestLowerDate: "2026-11-05" })], [], TODAY).create).toEqual([]);
    expect(evaluateStemRecommendations([stem({ ...base, harvestLowerDate: "2026-10-01" })], [], TODAY).create.map((c) => c.kind)).toEqual([
      "harvest_window",
    ]);
  });

  it("日数は圃場の設定（0 日なら下限の当日から）", () => {
    const settings = { ...DEFAULT_RECOMMENDATION_SETTINGS, harvestWindowDays: 0 };
    const base = { budEmergedAt: "2026-10-20", settings };
    expect(evaluateStemRecommendations([stem({ ...base, harvestLowerDate: "2026-10-29" })], [], TODAY).create).toEqual([]);
    expect(evaluateStemRecommendations([stem({ ...base, harvestLowerDate: TODAY })], [], TODAY).create).toHaveLength(1);
  });

  it("推定が無い・予測できなかった（下限 null）なら作らない", () => {
    expect(evaluateStemRecommendations([stem({ budEmergedAt: "2026-10-20", harvestLowerDate: null })], [], TODAY).create).toEqual([]);
  });

  it("収穫を記録すると done、袋掛け・摘蕾の open は「対象が終了」で dismissed（収穫の記録者）", () => {
    const harvested = ev("harvested", TODAY, { id: "e-h" });
    const r = evaluateStemRecommendations(
      [stem({ status: "harvested", events: [harvested], harvestLowerDate: "2026-11-01" })],
      [rec("harvest_window", "open"), rec("bag", "open"), rec("debud", "open")],
      TODAY,
    );
    expect(r.resolve).toEqual([
      { id: "r-bag-open", status: "dismissed", note: "対象が終了", resolvedBy: USER, eventId: "e-h" },
      { id: "r-debud-open", status: "dismissed", note: "対象が終了", resolvedBy: USER, eventId: "e-h" },
      { id: "r-harvest_window-open", status: "done", note: "収穫を記録", resolvedBy: USER, eventId: "e-h" },
    ]);
    expect(r.create).toEqual([]);
  });

  it("喪失（被害 lost）すると dismissed（理由「対象が終了」、被害のイベント）", () => {
    const lost = ev("damage", TODAY, { id: "e-lost", severity: "lost" });
    const severe = ev("damage", "2026-10-20", { id: "e-severe", severity: "severe" });
    const r = evaluateStemRecommendations(
      [stem({ status: "lost", events: [severe, lost], harvestLowerDate: "2026-11-01" })],
      [rec("harvest_window", "open")],
      TODAY,
    );
    expect(r.resolve).toEqual([{ id: "r-harvest_window-open", status: "dismissed", note: "対象が終了", resolvedBy: USER, eventId: "e-lost" }]);
  });

  it("終了の原因のイベントが見つからない（撤去など）ときは resolvedBy / eventId が null", () => {
    const r = evaluateStemRecommendations([stem({ status: "removed" })], [rec("bag", "open")], TODAY);
    expect(r.resolve).toEqual([{ id: "r-bag-open", status: "dismissed", note: "対象が終了", resolvedBy: null, eventId: null }]);
  });
});

describe("二重の防止と「無視」", () => {
  it("同じ対象・同じ kind で open があれば作らない", () => {
    const r = evaluateStemRecommendations([stem()], [rec("bag", "open"), rec("debud", "open")], TODAY);
    expect(r).toEqual({ create: [], resolve: [] });
  });

  it("「無視」（dismissed）した提案は、条件を満たしていても再び作らない", () => {
    const r = evaluateStemRecommendations([stem()], [rec("bag", "dismissed")], TODAY);
    expect(r.create.map((c) => c.kind)).toEqual(["debud"]);
  });

  it("done の提案も作り直さない（袋掛けの記録が訂正で消えても）", () => {
    expect(evaluateStemRecommendations([stem()], [rec("bag", "done"), rec("debud", "done")], TODAY).create).toEqual([]);
  });

  it("別の茎の提案は関係しない", () => {
    const r = evaluateStemRecommendations([stem()], [rec("bag", "dismissed", { targetId: "s2" })], TODAY);
    expect(r.create.map((c) => c.kind)).toEqual(["bag", "debud"]);
  });

  it("同じ入力で 2 回評価しても、作ったものを渡せば 2 回目は何もしない", () => {
    const first = evaluateStemRecommendations([stem()], [], TODAY);
    const existing = first.create.map((c, i) => rec(c.kind, "open", { id: `new-${i}` }));
    expect(evaluateStemRecommendations([stem()], existing, TODAY)).toEqual({ create: [], resolve: [] });
  });
});

describe("ルールの配列", () => {
  it("3-4 のルールは袋掛け・摘蕾・収穫期。ルールを渡せば足し引きできる", () => {
    expect(STEM_RULES.map((r) => r.kind)).toEqual(["bag", "debud", "harvest_window"]);
    const onlyHarvest = STEM_RULES.filter((r) => r.kind === "harvest_window");
    expect(evaluateStemRecommendations([stem()], [], TODAY, onlyHarvest).create).toEqual([]);
  });
});
