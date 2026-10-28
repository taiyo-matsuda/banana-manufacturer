import { describe, expect, it } from "vitest";
import { evaluateMatRecommendations, evaluateStemRecommendations, type ExistingRecommendation } from "./evaluate";
import { MAT_RULES, type MatFacts, STEM_RULES, type StemEventFact, type StemFacts } from "./rules";
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
  it("茎のルールは袋掛け・摘蕾・収穫期（3-4）と枯葉処理・確認（重い被害・検算ずれ）（3-5）。株のルールは収穫後の追肥。ルールを渡せば足し引きできる", () => {
    expect(STEM_RULES.map((r) => r.kind)).toEqual(["bag", "debud", "harvest_window", "remove_dead_leaves", "inspect", "inspect"]);
    expect(MAT_RULES.map((r) => r.kind)).toEqual(["fertilize_after_harvest"]);
    const onlyHarvest = STEM_RULES.filter((r) => r.kind === "harvest_window");
    expect(evaluateStemRecommendations([stem()], [], TODAY, onlyHarvest).create).toEqual([]);
  });
});

// --- 3-5 ------------------------------------------------------------------------------------------------

const OTHER = "22222222-2222-4222-8222-222222222222";
// 栽培中の茎（出蕾前）。3-4 のルールは出ない
const growing = (over: Partial<StemFacts> = {}): StemFacts =>
  stem({ status: "active", budEmergedAt: null, adoptedAt: null, startedAt: null, ...over });
const kinds = (r: { create: { kind: string; ruleKey: string }[] }) => r.create.map((c) => [c.kind, c.ruleKey]);

describe("枯葉処理（最後の枯葉処理、なければ採用・植え付けから X 日）", () => {
  it("採用から 30 日（既定）で出す。期限は採用日 + 30、rule_key は起点", () => {
    const r = evaluateStemRecommendations([growing({ adoptedAt: "2026-09-28", startedAt: "2026-08-01" })], [], TODAY);
    expect(r.create).toEqual([
      {
        kind: "remove_dead_leaves",
        targetType: "stem",
        targetId: "s1",
        ruleKey: "start:2026-09-28",
        dueAt: TODAY,
        reason: "採用・植え付け（9月28日）から 30 日。枯葉処理の記録がありません",
      },
    ]);
  });

  it("29 日目は出さない。採用日がなければ発生・植え付けの日から。起点がなければ出さない", () => {
    expect(evaluateStemRecommendations([growing({ adoptedAt: "2026-09-29" })], [], TODAY).create).toEqual([]);
    expect(kinds(evaluateStemRecommendations([growing({ startedAt: "2026-09-01" })], [], TODAY))).toEqual([
      ["remove_dead_leaves", "start:2026-09-01"],
    ]);
    expect(evaluateStemRecommendations([growing()], [], TODAY).create).toEqual([]);
  });

  it("最後の枯葉処理から X 日（圃場の設定 21 日）。出蕾済みの茎にも出す。吸芽・終了した茎には出さない", () => {
    const settings = { ...DEFAULT_RECOMMENDATION_SETTINGS, deadLeavesIntervalDays: 21 };
    const events = [ev("leaves_removed", "2026-09-01", { id: "l1" }), ev("leaves_removed", "2026-10-07", { id: "l2" })];
    const r = evaluateStemRecommendations([growing({ status: "flowered", adoptedAt: "2026-06-01", events, settings })], [], TODAY);
    expect(r.create.filter((c) => c.kind === "remove_dead_leaves")).toEqual([
      expect.objectContaining({ ruleKey: "leaves_removed:2026-10-07", dueAt: TODAY, reason: "最後の枯葉処理（10月7日）から 21 日" }),
    ]);
    for (const status of ["sucker", "harvested", "lost"]) {
      expect(evaluateStemRecommendations([growing({ status, adoptedAt: "2026-06-01" })], [], TODAY).create).toEqual([]);
    }
  });

  it("起点より後の枯葉処理で done（記録者・イベント）。採用起点なら同じ日の枯葉処理も done", () => {
    const removed = ev("leaves_removed", TODAY, { id: "l-new", recordedBy: OTHER });
    const r = evaluateStemRecommendations(
      [growing({ adoptedAt: "2026-09-01", events: [ev("leaves_removed", "2026-09-20", { id: "l-old" }), removed] })],
      [rec("remove_dead_leaves", "open", { ruleKey: "leaves_removed:2026-09-20" })],
      TODAY,
    );
    expect(r.resolve).toEqual([{ id: "r-remove_dead_leaves-open", status: "done", note: "枯葉処理を記録", resolvedBy: OTHER, eventId: "l-new" }]);
    expect(r.create).toEqual([]); // 起点が今日に進んだので次はまだ
    const sameDay = evaluateStemRecommendations(
      [growing({ adoptedAt: "2026-09-01", events: [ev("leaves_removed", "2026-09-01", { id: "l-same" })] })],
      [rec("remove_dead_leaves", "open", { ruleKey: "start:2026-09-01" })],
      TODAY,
    );
    expect(sameDay.resolve).toEqual([expect.objectContaining({ status: "done", eventId: "l-same" })]);
  });

  it("起点の枯葉処理を（同じ日のまま）訂正しても done にしない。起点と同じ鍵の「無視」は作り直さない", () => {
    const corrected = ev("leaves_removed", "2026-09-20", { id: "l-corrected" });
    const r = evaluateStemRecommendations(
      [growing({ adoptedAt: "2026-09-01", events: [corrected] })],
      [rec("remove_dead_leaves", "open", { ruleKey: "leaves_removed:2026-09-20" })],
      TODAY,
    );
    expect(r).toEqual({ create: [], resolve: [] });
    const dismissed = evaluateStemRecommendations(
      [growing({ adoptedAt: "2026-09-01", events: [corrected] })],
      [rec("remove_dead_leaves", "dismissed", { ruleKey: "leaves_removed:2026-09-20" })],
      TODAY,
    );
    expect(dismissed.create).toEqual([]);
  });

  it("done の後、次の枯葉処理から X 日たつと次の回の提案（新しい鍵）", () => {
    const r = evaluateStemRecommendations(
      [growing({ adoptedAt: "2026-08-01", events: [ev("leaves_removed", "2026-09-20", { id: "l1" })] })],
      [rec("remove_dead_leaves", "done", { ruleKey: "start:2026-08-01" })],
      TODAY,
    );
    expect(kinds(r)).toEqual([["remove_dead_leaves", "leaves_removed:2026-09-20"]]);
  });

  it("茎が終了したら open は「対象が終了」", () => {
    const harvested = ev("harvested", TODAY, { id: "e-h" });
    const r = evaluateStemRecommendations(
      [growing({ status: "harvested", adoptedAt: "2026-06-01", events: [harvested] })],
      [rec("remove_dead_leaves", "open", { ruleKey: "start:2026-06-01" })],
      TODAY,
    );
    expect(r.resolve).toEqual([{ id: "r-remove_dead_leaves-open", status: "dismissed", note: "対象が終了", resolvedBy: USER, eventId: "e-h" }]);
  });
});

describe("確認（重い被害）", () => {
  const severe = ev("damage", "2026-10-25", { id: "d1", severity: "severe", damageKind: "lodging" });

  it("最新の茎の被害が severe なら出す。期限は今日、rule_key は被害のイベント", () => {
    const r = evaluateStemRecommendations([growing({ events: [severe] })], [], TODAY);
    expect(r.create).toEqual([
      {
        kind: "inspect",
        targetType: "stem",
        targetId: "s1",
        ruleKey: "damage:d1",
        dueAt: TODAY,
        reason: "重い被害（倒伏・重、10月25日）を確認してください",
      },
    ]);
  });

  it("軽・中には出さない。severe の後に軽い被害を記録していれば出さない", () => {
    const moderate = ev("damage", "2026-10-25", { id: "d2", severity: "moderate" });
    expect(evaluateStemRecommendations([growing({ events: [moderate] })], [], TODAY).create).toEqual([]);
    const later = ev("damage", "2026-10-27", { id: "d3", severity: "light" });
    expect(evaluateStemRecommendations([growing({ events: [severe, later] })], [], TODAY).create).toEqual([]);
  });

  it("その後に茎の被害を記録し直すと done（記録者・イベント）", () => {
    const later = ev("damage", "2026-10-27", { id: "d3", severity: "light", recordedBy: OTHER });
    const r = evaluateStemRecommendations([growing({ events: [severe, later] })], [rec("inspect", "open", { ruleKey: "damage:d1" })], TODAY);
    expect(r.resolve).toEqual([{ id: "r-inspect-open", status: "done", note: "被害を記録し直した", resolvedBy: OTHER, eventId: "d3" }]);
    expect(r.create).toEqual([]);
  });

  it("被害の記録を訂正すると done（訂正した行の記録者・イベント）。訂正後も severe なら新しい鍵で次の確認", () => {
    const fixed = ev("damage", "2026-10-25", { id: "d1b", severity: "severe", damageKind: "break", recordedBy: OTHER });
    const r = evaluateStemRecommendations(
      [growing({ events: [fixed], replacedBy: { d1: { id: "d1b", recordedBy: OTHER } } })],
      [rec("inspect", "open", { ruleKey: "damage:d1" })],
      TODAY,
    );
    expect(r.resolve).toEqual([{ id: "r-inspect-open", status: "done", note: "被害の記録を訂正", resolvedBy: OTHER, eventId: "d1b" }]);
    expect(kinds(r)).toEqual([["inspect", "damage:d1b"]]);
  });

  it("喪失（lost）には出さず、open は「対象が終了」", () => {
    const lost = ev("damage", TODAY, { id: "d-lost", severity: "lost" });
    const r = evaluateStemRecommendations(
      [growing({ status: "lost", events: [severe, lost] })],
      [rec("inspect", "open", { ruleKey: "damage:d1" })],
      TODAY,
    );
    expect(r.resolve).toEqual([{ id: "r-inspect-open", status: "dismissed", note: "対象が終了", resolvedBy: USER, eventId: "d-lost" }]);
    expect(r.create).toEqual([]);
  });
});

describe("確認（累計葉数の検算ずれ ≥ 3、茎の画面の警告と同じ式 leaves.ts）", () => {
  const obs = (id: string, value: number, observedAt: string, observedBy: string | null = USER) => ({ id, value, observedAt, observedBy });
  // 記録時点の累計 = 5 + 10 = 15（10/1 の新葉）。検算 = 現在の葉数 + それまでの枯葉処理
  const base = { initialLeafCount: 5, leavesNew: [{ value: 10, observedAt: "2026-10-01T01:00:00Z" }] };

  it("ずれが 3 枚以上で出す。理由に枚数、rule_key は検算に使った現在の葉数の観測", () => {
    const r = evaluateStemRecommendations([growing({ ...base, leavesCurrent: [obs("o1", 12, "2026-10-27T01:00:00Z")] })], [], TODAY);
    expect(r.create).toEqual([
      {
        kind: "inspect",
        targetType: "stem",
        targetId: "s1",
        ruleKey: "leaf_check:o1",
        dueAt: TODAY,
        reason: "累計葉数の検算が 3 枚ずれています（記録時点の累計 15、検算 12）",
      },
    ]);
  });

  it("2 枚のずれ・現在の葉数の記録なし・初期葉数なしでは出さない。枯葉処理（現在の葉数より前）は検算に足す", () => {
    expect(evaluateStemRecommendations([growing({ ...base, leavesCurrent: [obs("o1", 13, "2026-10-27T01:00:00Z")] })], [], TODAY).create).toEqual([]);
    expect(evaluateStemRecommendations([growing(base)], [], TODAY).create).toEqual([]);
    expect(
      evaluateStemRecommendations([growing({ ...base, initialLeafCount: null, leavesCurrent: [obs("o1", 2, "2026-10-27T01:00:00Z")] })], [], TODAY)
        .create,
    ).toEqual([]);
    const removed = ev("leaves_removed", "2026-10-20", { id: "l1", count: 3, occurredAt: "2026-10-20T01:00:00Z" });
    const after = ev("leaves_removed", "2026-10-28", { id: "l2", count: 5, occurredAt: "2026-10-28T01:00:00Z" });
    expect(
      evaluateStemRecommendations(
        [growing({ ...base, events: [removed, after], leavesCurrent: [obs("o1", 12, "2026-10-27T01:00:00Z")] })],
        [],
        TODAY,
      ).create,
    ).toEqual([]); // 12 + 3 = 15（後の枯葉処理は数えない）
  });

  it("最新の現在の葉数で判定する（古い観測のずれは見ない）", () => {
    const current = [obs("o-old", 5, "2026-10-01T01:00:00Z"), obs("o-new", 15, "2026-10-27T01:00:00Z")];
    expect(evaluateStemRecommendations([growing({ ...base, leavesCurrent: current })], [], TODAY).create).toEqual([]);
  });

  it("現在の葉数を記録し直すと done（記録者）。まだずれていれば新しい観測で次の確認", () => {
    const current = [obs("o1", 12, "2026-10-27T01:00:00Z"), obs("o2", 11, "2026-10-28T01:00:00Z", OTHER)];
    const r = evaluateStemRecommendations([growing({ ...base, leavesCurrent: current })], [rec("inspect", "open", { ruleKey: "leaf_check:o1" })], TODAY);
    expect(r.resolve).toEqual([{ id: "r-inspect-open", status: "done", note: "現在の葉数を記録", resolvedBy: OTHER, eventId: null }]);
    expect(kinds(r)).toEqual([["inspect", "leaf_check:o2"]]);
  });

  it("その観測を訂正すると done（訂正した行の記録者）。訂正でずれが無くなれば次は出ない", () => {
    const r = evaluateStemRecommendations(
      [
        growing({
          ...base,
          leavesCurrent: [obs("o1b", 15, "2026-10-27T01:00:00Z", OTHER)],
          replacedBy: { o1: { id: "o1b", recordedBy: OTHER } },
        }),
      ],
      [rec("inspect", "open", { ruleKey: "leaf_check:o1" })],
      TODAY,
    );
    expect(r).toEqual({ create: [], resolve: [{ id: "r-inspect-open", status: "done", note: "葉数の記録を訂正", resolvedBy: OTHER, eventId: null }] });
  });

  it("新葉の訂正などでずれが 3 枚未満になれば done（検算のずれが解消）", () => {
    const r = evaluateStemRecommendations(
      [growing({ ...base, leavesNew: [{ value: 8, observedAt: "2026-10-01T01:00:00Z" }], leavesCurrent: [obs("o1", 12, "2026-10-27T01:00:00Z")] })],
      [rec("inspect", "open", { ruleKey: "leaf_check:o1" })],
      TODAY,
    );
    expect(r.resolve).toEqual([{ id: "r-inspect-open", status: "done", note: "検算のずれが解消", resolvedBy: null, eventId: null }]);
  });

  describe("3-5a: 現在の葉数を記録した時点で比べる", () => {
    const leavesNew = (...items: [number, string][]) => items.map(([value, observedAt]) => ({ value, observedAt }));

    it("完了条件 1: 現在の葉数を記録した後に新葉を 3 枚以上記録しても出さない", () => {
      const facts = growing({
        initialLeafCount: 5,
        leavesCurrent: [obs("o1", 5, "2026-10-20T01:00:00Z")],
        leavesNew: leavesNew([1, "2026-10-21T01:00:00Z"], [2, "2026-10-24T01:00:00Z"], [1, "2026-10-27T01:00:00Z"]),
      });
      expect(evaluateStemRecommendations([facts], [], TODAY)).toEqual({ create: [], resolve: [] });
    });

    it("完了条件 2: 記録した時点で 3 枚以上ずれていれば、後の新葉があっても出す（理由は記録時点の値）", () => {
      const facts = growing({
        initialLeafCount: 5,
        leavesCurrent: [obs("o1", 9, "2026-10-20T01:00:00Z")],
        leavesNew: leavesNew([1, "2026-10-19T01:00:00Z"], [3, "2026-10-25T01:00:00Z"]),
      });
      expect(evaluateStemRecommendations([facts], [], TODAY).create).toEqual([
        expect.objectContaining({ ruleKey: "leaf_check:o1", reason: "累計葉数の検算が 3 枚ずれています（記録時点の累計 6、検算 9）" }),
      ]);
    });

    it("完了条件 3: 以前の式で出た open の確認は、新しい式でずれが 3 枚未満なら done（検算のずれが解消）", () => {
      // 以前の式: 今の累計 5 + 4 = 9 と 現在の葉数 5 → 4 枚のずれで open。新しい式: 記録時点の累計 5 と 5 → ずれなし
      const facts = growing({
        initialLeafCount: 5,
        leavesCurrent: [obs("o1", 5, "2026-10-20T01:00:00Z")],
        leavesNew: leavesNew([2, "2026-10-21T01:00:00Z"], [2, "2026-10-24T01:00:00Z"]),
      });
      const r = evaluateStemRecommendations([facts], [rec("inspect", "open", { ruleKey: "leaf_check:o1" })], TODAY);
      expect(r).toEqual({
        create: [],
        resolve: [{ id: "r-inspect-open", status: "done", note: "検算のずれが解消", resolvedBy: null, eventId: null }],
      });
    });
  });

  it("重い被害と検算ずれが両方あっても、確認の open は 1 件まで（重い被害が先）。被害の確認が閉じたら検算の確認", () => {
    const severe = ev("damage", "2026-10-25", { id: "d1", severity: "severe" });
    const facts = growing({ ...base, events: [severe], leavesCurrent: [obs("o1", 12, "2026-10-27T01:00:00Z")] });
    expect(kinds(evaluateStemRecommendations([facts], [], TODAY))).toEqual([["inspect", "damage:d1"]]);
    // 被害の確認が open の間は、検算の確認を作らず、検算のルールが被害の確認を閉じることもない
    expect(evaluateStemRecommendations([facts], [rec("inspect", "open", { ruleKey: "damage:d1" })], TODAY)).toEqual({ create: [], resolve: [] });
    expect(kinds(evaluateStemRecommendations([facts], [rec("inspect", "dismissed", { ruleKey: "damage:d1" })], TODAY))).toEqual([
      ["inspect", "leaf_check:o1"],
    ]);
  });
});

describe("収穫後の追肥（株が対象）", () => {
  const mat = (over: Partial<MatFacts> = {}): MatFacts => ({
    matId: "m1",
    status: "active",
    harvestDates: [],
    fertilizations: [],
    removal: null,
    settings: DEFAULT_RECOMMENDATION_SETTINGS,
    ...over,
  });
  const matRec = (status: string, over: Partial<ExistingRecommendation> = {}): ExistingRecommendation =>
    rec("fertilize_after_harvest", status, { targetType: "mat", targetId: "m1", ruleKey: "harvest:2026-10-26", ...over });
  const fert = (date: string, recordedBy = USER) => ({ id: `f-${date}`, date, recordedBy });

  it("収穫を記録したら出す。期限は収穫日 + M（既定 7）、rule_key は最後の収穫日", () => {
    const r = evaluateMatRecommendations([mat({ harvestDates: ["2026-08-01", "2026-10-26"] })], [], TODAY);
    expect(r.create).toEqual([
      {
        kind: "fertilize_after_harvest",
        targetType: "mat",
        targetId: "m1",
        ruleKey: "harvest:2026-10-26",
        dueAt: "2026-11-02",
        reason: "収穫（10月26日）から 7 日以内に追肥",
      },
    ]);
  });

  it("M は圃場の設定。収穫日以降（同じ日を含む）に施肥があれば出さない。収穫がない・撤去した株には出さない", () => {
    const settings = { ...DEFAULT_RECOMMENDATION_SETTINGS, fertilizeAfterHarvestDays: 3 };
    expect(evaluateMatRecommendations([mat({ harvestDates: ["2026-10-26"], settings })], [], TODAY).create[0]?.dueAt).toBe("2026-10-29");
    expect(evaluateMatRecommendations([mat({ harvestDates: ["2026-10-26"], fertilizations: [fert("2026-10-26")] })], [], TODAY).create).toEqual([]);
    expect(evaluateMatRecommendations([mat({ harvestDates: ["2026-10-26"], fertilizations: [fert("2026-10-25")] })], [], TODAY).create).toHaveLength(1);
    expect(evaluateMatRecommendations([mat()], [], TODAY).create).toEqual([]);
    expect(evaluateMatRecommendations([mat({ status: "removed", harvestDates: ["2026-10-26"] })], [], TODAY).create).toEqual([]);
  });

  it("その株に施肥（一括入力を含む）を記録すると done（記録者・イベント）", () => {
    const r = evaluateMatRecommendations([mat({ harvestDates: ["2026-10-26"], fertilizations: [fert(TODAY, OTHER)] })], [matRec("open")], TODAY);
    expect(r).toEqual({
      create: [],
      resolve: [{ id: "r-fertilize_after_harvest-open", status: "done", note: "施肥を記録", resolvedBy: OTHER, eventId: `f-${TODAY}` }],
    });
  });

  it("期限を過ぎても施肥がなければ open のまま。open の間に別の茎を収穫しても 2 件目は作らない", () => {
    expect(evaluateMatRecommendations([mat({ harvestDates: ["2026-10-01"] })], [matRec("open", { ruleKey: "harvest:2026-10-01" })], TODAY)).toEqual({
      create: [],
      resolve: [],
    });
    expect(
      evaluateMatRecommendations([mat({ harvestDates: ["2026-10-01", TODAY] })], [matRec("open", { ruleKey: "harvest:2026-10-01" })], TODAY).create,
    ).toEqual([]);
  });

  it("「無視」した収穫は作り直さない。次の収穫では新しい提案", () => {
    expect(evaluateMatRecommendations([mat({ harvestDates: ["2026-10-26"] })], [matRec("dismissed")], TODAY).create).toEqual([]);
    const r = evaluateMatRecommendations([mat({ harvestDates: ["2026-10-26", TODAY], fertilizations: [fert("2026-10-27")] })], [matRec("done")], TODAY);
    expect(kinds(r)).toEqual([["fertilize_after_harvest", `harvest:${TODAY}`]]);
  });

  it("株を撤去したら open は「対象が終了」（撤去のイベントと記録者）", () => {
    const r = evaluateMatRecommendations(
      [mat({ status: "removed", harvestDates: ["2026-10-26"], removal: { id: "e-rm", recordedBy: OTHER } })],
      [matRec("open")],
      TODAY,
    );
    expect(r).toEqual({
      create: [],
      resolve: [{ id: "r-fertilize_after_harvest-open", status: "dismissed", note: "対象が終了", resolvedBy: OTHER, eventId: "e-rm" }],
    });
  });

  it("茎の提案と株の提案は混ざらない（同じ id でも対象の種類で分ける）", () => {
    const stemSide = rec("fertilize_after_harvest", "dismissed", { targetId: "m1", ruleKey: "harvest:2026-10-26" });
    expect(evaluateMatRecommendations([mat({ harvestDates: ["2026-10-26"] })], [stemSide], TODAY).create).toHaveLength(1);
  });
});
