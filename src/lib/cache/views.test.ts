import { describe, expect, it } from "vitest";
import { computeWeekly } from "../weekly";
import { matchShellRoute } from "./shell-route";
import type { CacheSnapshot, CachedEvent, CachedMat, CachedObservation, CachedPhoto, CachedStem } from "./types";
import { fieldDetailFromCache, fieldMapFromCache, homeFields, matDetailFromCache, stemFromCache, weeklyRowsFromCache } from "./views";

const ORG = "org-a";
const base = (id: string) => ({ id, organization_id: ORG, updated_at: "2026-10-25T00:00:00+00:00", created_at: "2026-10-25T00:00:00+00:00" });
const fieldRow = (id: string, name: string) => ({ ...base(id), name, code: name.slice(0, 2), center_lat: 26.5, center_lng: 127.9, notes: null });
const mat = (id: string, fieldId: string, code: string, extra: Partial<CachedMat> = {}): CachedMat => ({
  ...base(id),
  field_id: fieldId,
  code,
  cultivar_id: "c1",
  lat: 26.5,
  lng: 127.9,
  planted_at: "2026-09-01",
  origin_type: "tissue_culture",
  origin_stem_id: null,
  status: "active",
  ...extra,
});
const stem = (id: string, matId: string, extra: Partial<CachedStem> = {}): CachedStem => ({
  ...base(id),
  mat_id: matId,
  generation: 1,
  parent_stem_id: null,
  status: "active",
  started_at: "2026-09-01",
  initial_leaf_count: 3,
  bud_emerged_at: null,
  ...extra,
});
const obs = (id: string, stemId: string, type: string, value: number | string, at: string, superseded_by: string | null = null): CachedObservation => ({
  ...base(id),
  stem_id: stemId,
  type,
  value,
  observed_at: at,
  observed_by: "u",
  note: null,
  superseded_by,
});
const ev = (id: string, targetType: string, targetId: string, type: string, at: string, extra: Partial<CachedEvent> = {}): CachedEvent => ({
  ...base(id),
  type,
  target_type: targetType,
  target_id: targetId,
  occurred_at: at,
  recorded_by: "u",
  payload: {},
  note: null,
  superseded_by: null,
  ...extra,
});
const photo = (id: string, stemId: string): CachedPhoto => ({
  ...base(id),
  storage_path: `p/${id}.jpg`,
  taken_at: "2026-10-20T00:00:00+00:00",
  taken_by: "u",
  target_type: "stem",
  target_id: stemId,
  kind: "bunch",
});

const snapshot: CacheSnapshot = {
  fields: [fieldRow("f2", "北"), fieldRow("f1", "東")],
  mats: [
    mat("m1", "f1", "A-002"),
    mat("m2", "f1", "A-010"),
    mat("m3", "f1", "A-001", { status: "removed" }),
    mat("m4", "f2", "B-001", { origin_type: "sucker_transplant", origin_stem_id: "s1" }),
  ],
  stems: [
    stem("s1", "m1"),
    stem("s1b", "m1", { generation: 2, status: "sucker", started_at: "2026-10-01", initial_leaf_count: 0, parent_stem_id: "s1" }),
    stem("s2", "m2", { status: "flowered", bud_emerged_at: "2026-10-10" }),
    stem("s3", "m3"),
  ],
  observations: [
    obs("o1", "s1", "leaves_new", "1", "2026-10-01T01:00:00+00:00"),
    obs("o2", "s1", "leaves_new", 2, "2026-10-08T01:00:00+00:00", "o3"), // 訂正済み
    obs("o3", "s1", "leaves_new", 1, "2026-10-08T01:00:00+00:00"),
    obs("o4", "s1", "leaves_current", 9, "2026-10-08T01:00:00+00:00"),
  ],
  events: [
    ev("e1", "field", "f1", "damage", "2026-10-02T00:00:00+00:00", { note: "台風" }),
    ev("e2", "field", "f1", "fertilized", "2026-10-05T00:00:00+00:00"),
    ev("e3", "mat", "m3", "mat_removed", "2026-10-03T00:00:00+00:00", { payload: { reason: "枯死" } }),
    ev("e4", "stem", "s1", "leaves_removed", "2026-10-04T00:00:00+00:00", { payload: { count: 1 } }),
  ],
  photos: [photo("p1", "s1")],
};

describe("homeFields / weeklyRowsFromCache", () => {
  it("圃場は名前順", () => {
    expect(homeFields(snapshot).map((f) => f.id)).toEqual(["f2", "f1"]);
  });

  it("weekly_stems（0016）と同じ行: 撤去済みの株・吸芽を除き、leaves_new の最後の日時と合計は訂正済みを除く", () => {
    const rows = weeklyRowsFromCache(snapshot);
    expect(rows.map((r) => r.stem_id).sort()).toEqual(["s1", "s2"]);
    const s1 = rows.find((r) => r.stem_id === "s1")!;
    expect(s1).toMatchObject({ mat_code: "A-002", field_name: "東", last_leaves_new_at: "2026-10-08T01:00:00+00:00", leaves_new_sum: 2 });
    expect(rows.find((r) => r.stem_id === "s2")).toMatchObject({ last_leaves_new_at: null, leaves_new_sum: 0, bud_emerged_at: "2026-10-10" });
    // 既存の純粋関数（src/lib/weekly.ts）でそのまま計算できる
    const items = computeWeekly(rows, "2026-10-26", 7);
    expect(items.map((i) => i.matCode)).toEqual(["A-010", "A-002"]);
    expect(items[1].cumulativeLeaves).toBe(5);
  });
});

describe("fieldDetailFromCache / fieldMapFromCache", () => {
  it("圃場の記録は圃場のイベントを新しい順。無い圃場は null", () => {
    const d = fieldDetailFromCache(snapshot, "f1")!;
    expect(d.field.name).toBe("東");
    expect(d.history.map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(d.history[1]).toMatchObject({ note: "台風", recorder_name: null });
    expect(fieldDetailFromCache(snapshot, "nope")).toBeNull();
  });

  it("地図は撤去していない株を株コード順（数値として）、代表の茎の状態付き", () => {
    const m = fieldMapFromCache(snapshot, "f1")!;
    expect(m.mats.map((x) => [x.code, x.stemStatus])).toEqual([
      ["A-002", "active"],
      ["A-010", "flowered"],
    ]);
  });
});

describe("matDetailFromCache", () => {
  it("茎は世代順、観測は現在の値だけ。品種名は meta の品種から", () => {
    const d = matDetailFromCache(snapshot, "m1", [{ id: "c1", name: "ドワーフナムワ" }])!;
    expect(d.mat.code).toBe("A-002");
    expect(d.field).toEqual({ id: "f1", name: "東", code: "東" });
    expect(d.cultivarName).toBe("ドワーフナムワ");
    expect(d.stems.map((s) => s.id)).toEqual(["s1", "s1b"]);
    expect(d.stems[0].observations.map((o) => o.id).sort()).toEqual(["o1", "o3", "o4"]);
    expect(d.stems[0].observations.find((o) => o.id === "o1")?.value).toBe(1);
    expect(d.removedEvent).toBeNull();
  });

  it("撤去済みの株は撤去の記録、株分けの株は由来（元の茎の株と世代）", () => {
    expect(matDetailFromCache(snapshot, "m3", [])!.removedEvent).toMatchObject({ occurred_at: "2026-10-03T00:00:00+00:00", payload: { reason: "枯死" } });
    expect(matDetailFromCache(snapshot, "m4", [])!.origin).toEqual({ matId: "m1", matCode: "A-002", generation: 1 });
    expect(matDetailFromCache(snapshot, "m4", [])!.cultivarName).toBeNull();
    expect(matDetailFromCache(snapshot, "nope", [])).toBeNull();
  });
});

describe("stemFromCache", () => {
  it("観測（訂正済みも）・茎のイベント・写真（画像なし、offline）と、記録者 id（meta のユーザー）", () => {
    const s = stemFromCache(snapshot, "s1", { organization_id: ORG, user_id: "me" })!;
    expect(s).toMatchObject({ id: "s1", mat: { id: "m1", code: "A-002" }, userId: "me", organizationId: ORG, initialLeafCount: 3 });
    expect(s.observations.map((o) => o.id)).toEqual(["o2", "o3", "o4", "o1"]); // 観測日時の新しい順
    expect(s.observations.find((o) => o.id === "o2")?.superseded_by).toBe("o3");
    expect(s.events.map((e) => e.id)).toEqual(["e4"]);
    expect(s.photos).toEqual([{ id: "p1", kind: "bunch", taken_at: "2026-10-20T00:00:00+00:00", url: null, taker_name: null, offline: true }]);
    expect(stemFromCache(snapshot, "nope", { organization_id: ORG, user_id: "me" })).toBeNull();
  });
});

describe("matchShellRoute", () => {
  it("殻の対象の URL だけを判定する", () => {
    expect(matchShellRoute("/")).toEqual({ kind: "home" });
    expect(matchShellRoute("/fields/abc-1")).toEqual({ kind: "field", fieldId: "abc-1" });
    expect(matchShellRoute("/fields/abc-1/map")).toEqual({ kind: "map", fieldId: "abc-1" });
    expect(matchShellRoute("/mats/m1/")).toEqual({ kind: "mat", matId: "m1" });
    expect(matchShellRoute("/stems/s1")).toEqual({ kind: "stem", stemId: "s1" });
    expect(matchShellRoute("/stems/s1/history")).toEqual({ kind: "history", stemId: "s1" });
    for (const p of ["/fields", "/fields/new", "/fields/f1/edit", "/fields/f1/fertilize", "/mats/m1/edit", "/stems/s1/transplant", "/weekly", "/map", "/offline-shell"]) {
      expect(matchShellRoute(p), p).toBeNull();
    }
  });
});
