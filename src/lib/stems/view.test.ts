import { describe, expect, it } from "vitest";
import type { MatStemRow } from "../offline/overlay";
import type { EventRow, ObservationRow } from "./records";
import { buildStemView, matStemLeafCheck } from "./view";

// 3-5a: 茎の画面の警告（buildStemView）と株の詳細の茎一覧（matStemLeafCheck）が leaves.ts の同じ検算を使う
const o = (id: string, type: string, value: number, at: string, supersededBy: string | null = null): ObservationRow => ({
  id,
  type,
  value,
  observed_at: at,
  superseded_by: supersededBy,
});
const removed = (id: string, count: number, at: string, supersededBy: string | null = null): EventRow => ({
  id,
  type: "leaves_removed",
  occurred_at: at,
  payload: { count },
  superseded_by: supersededBy,
});

function view(observations: ObservationRow[], events: EventRow[] = []) {
  return buildStemView({
    id: "s1",
    generation: 1,
    status: "active",
    initialLeafCount: 5,
    mat: { id: "m1", code: "A-001" },
    userId: "u",
    organizationId: "org",
    observations,
    events,
    photos: [],
  });
}

describe("buildStemView の検算（茎の画面の警告）", () => {
  it("現在の葉数を記録した後の新葉 3 枚は検算に入れない（警告なし）。累計は後の新葉も数える", () => {
    const v = view([
      o("c1", "leaves_current", 5, "2026-10-01T01:00:00Z"),
      o("n1", "leaves_new", 2, "2026-10-08T01:00:00Z"),
      o("n2", "leaves_new", 1, "2026-10-15T01:00:00Z"),
    ]);
    expect(v.cumulative).toBe(8);
    expect(v.check).toMatchObject({ observationId: "c1", cumulative: 5, byCheck: 5, needsCheck: false });
    expect(v.checkWarning).toBeNull();
  });

  it("記録した時点で 3 枚以上ずれていれば警告（記録時点の累計と検算）", () => {
    const v = view([o("n1", "leaves_new", 1, "2026-10-01T01:00:00Z"), o("c1", "leaves_current", 10, "2026-10-02T01:00:00Z")], [
      removed("r1", 1, "2026-10-01T05:00:00Z"),
    ]);
    expect(v.checkWarning).toBe("確認してください（記録時点の累計 6、検算 11）");
  });

  it("訂正された（superseded_by のある）観測・枯葉処理は使わない", () => {
    const v = view(
      [
        o("c-old", "leaves_current", 20, "2026-10-03T01:00:00Z", "c-new"),
        o("c-new", "leaves_current", 4, "2026-10-03T01:00:00Z"),
        o("n-old", "leaves_new", 9, "2026-10-02T01:00:00Z", "n-new"),
        o("n-new", "leaves_new", 1, "2026-10-02T01:00:00Z"),
      ],
      [removed("r-old", 9, "2026-10-01T01:00:00Z", "r-new"), removed("r-new", 2, "2026-10-01T01:00:00Z")],
    );
    expect(v.check).toMatchObject({ observationId: "c-new", cumulative: 6, byCheck: 6, needsCheck: false });
  });
});

describe("matStemLeafCheck（株の詳細の茎一覧）", () => {
  const stem = (over: Partial<MatStemRow> = {}): MatStemRow => ({
    id: "s1",
    generation: 1,
    status: "active",
    started_at: "2026-09-01",
    initial_leaf_count: 5,
    parent_stem_id: null,
    observations: [],
    ...over,
  });

  it("茎の画面と同じ式: 後の新葉は入れず、その時点以前の枯葉処理を足す", () => {
    const observations = [
      { id: "c1", type: "leaves_current", value: 3, observed_at: "2026-10-02T01:00:00Z" },
      { id: "n1", type: "leaves_new", value: 4, observed_at: "2026-10-05T01:00:00Z" },
      { id: "h1", type: "height_cm", value: 120, observed_at: "2026-10-05T01:00:00Z" },
    ];
    expect(matStemLeafCheck(stem({ observations, leaves_removed: [{ id: "r1", count: 2, occurred_at: "2026-10-01T01:00:00Z" }] }))).toMatchObject({
      cumulative: 5,
      byCheck: 5,
      needsCheck: false,
    });
    expect(matStemLeafCheck(stem({ observations }))).toMatchObject({ cumulative: 5, byCheck: 3, needsCheck: false });
    expect(matStemLeafCheck(stem({ observations: [{ id: "c1", type: "leaves_current", value: 9, observed_at: "2026-10-02T01:00:00Z" }] }))).toMatchObject({
      diff: 4,
      needsCheck: true,
    });
  });

  it("吸芽・現在の葉数なしは null", () => {
    expect(matStemLeafCheck(stem({ status: "sucker", observations: [{ id: "c1", type: "leaves_current", value: 9, observed_at: "2026-10-02T01:00:00Z" }] }))).toBeNull();
    expect(matStemLeafCheck(stem())).toBeNull();
  });
});
