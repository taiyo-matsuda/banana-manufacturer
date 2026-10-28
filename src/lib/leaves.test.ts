import { describe, expect, it } from "vitest";
import { cumulativeLeaves, leafCheck, leafCheckPointMs, leafCheckWarning, type LeafObservation } from "./leaves";

const d = (s: string) => new Date(s);
const added = (value: number, at: string): LeafObservation => ({ type: "leaves_new", value, observedAt: d(at) });
const current = (value: number, at: string, id?: string): LeafObservation => ({ type: "leaves_current", value, observedAt: d(at), id });

describe("cumulativeLeaves", () => {
  it("初期葉数に leaves_new を足す", () => {
    const obs: LeafObservation[] = [added(1, "2026-11-01"), added(2, "2026-11-10"), current(8, "2026-11-10")];
    expect(cumulativeLeaves(5, obs)).toBe(8);
  });

  it("観測がなければ初期葉数のまま", () => {
    expect(cumulativeLeaves(4, [])).toBe(4);
  });
});

describe("leafCheck（3-5a: 最新の現在の葉数を記録した時点で比べる）", () => {
  it("最新の現在の葉数に、その時点以前の枯葉処理を足す。累計もその時点以前の新葉だけ", () => {
    const obs = [
      added(2, "2026-11-05T01:00:00Z"),
      current(10, "2026-11-01T01:00:00Z", "c-old"),
      current(9, "2026-12-01T01:00:00Z", "c-new"),
      added(4, "2026-12-10T01:00:00Z"), // 現在の葉数より後なので入れない
    ];
    const removed = [
      { count: 2, occurredAt: d("2026-11-15T01:00:00Z") },
      { count: 1, occurredAt: d("2026-12-15T01:00:00Z") }, // 最新観測より後なので含めない
    ];
    expect(leafCheck(10, obs, removed)).toEqual({
      observationId: "c-new",
      cumulative: 12, // 10 + 2（後の 4 は入れない）
      byCheck: 11, // 9 + 2
      diff: 1,
      needsCheck: false,
    });
  });

  it("完了条件 1: 現在の葉数を記録した後に新葉を 3 枚以上記録しても、ずれにならない", () => {
    const obs = [current(5, "2026-10-01T01:00:00Z", "c1"), added(1, "2026-10-08T01:00:00Z"), added(2, "2026-10-15T01:00:00Z"), added(1, "2026-10-22T01:00:00Z")];
    const check = leafCheck(5, obs, []);
    expect(check).toMatchObject({ cumulative: 5, byCheck: 5, diff: 0, needsCheck: false });
    expect(leafCheckWarning(check)).toBeNull();
    // 画面の累計（出蕾予測用）は後の新葉も数える
    expect(cumulativeLeaves(5, obs)).toBe(9);
  });

  it("完了条件 2: 記録した時点で 3 枚以上ずれていれば、その後の新葉でずれが消えたように見えても警告のまま", () => {
    const obs = [current(8, "2026-10-01T01:00:00Z", "c1"), added(3, "2026-10-08T01:00:00Z")];
    const check = leafCheck(5, obs, []);
    expect(check).toMatchObject({ cumulative: 5, byCheck: 8, diff: 3, needsCheck: true });
    expect(leafCheckWarning(check)).toBe("確認してください（記録時点の累計 5、検算 8）");
    // 記録し直すと、新しい時点で比べる
    expect(leafCheck(5, [...obs, current(8, "2026-10-09T01:00:00Z", "c2")], [])).toMatchObject({
      observationId: "c2",
      cumulative: 8,
      byCheck: 8,
      needsCheck: false,
    });
  });

  it("同じ observed_at の新葉・枯葉処理は「以前」に含める", () => {
    const at = "2026-10-01T01:00:00.123Z";
    const check = leafCheck(5, [added(2, at), current(4, at, "c1")], [{ count: 3, occurredAt: d(at) }]);
    expect(check).toMatchObject({ cumulative: 7, byCheck: 7, needsCheck: false });
    // 1 ミリ秒でも後なら入れない
    const later = "2026-10-01T01:00:00.124Z";
    expect(leafCheck(5, [added(2, later), current(4, at, "c1")], [{ count: 3, occurredAt: d(later) }])).toMatchObject({
      cumulative: 5,
      byCheck: 4,
    });
  });

  it("日付だけの記録（日本時間 0:00 ちょうど、過去日の出蕾の生葉数）は、その日の終わりの時点で比べる", () => {
    const midnight = "2026-10-01T00:00:00+09:00";
    expect(leafCheckPointMs(d(midnight))).toBe(d("2026-10-01T23:59:59.999+09:00").getTime());
    expect(leafCheckPointMs(d("2026-10-01T09:30:00+09:00"))).toBe(d("2026-10-01T09:30:00+09:00").getTime());
    const obs = [
      added(2, "2026-10-01T10:00:00+09:00"), // 同じ日の新葉は含める
      current(7, midnight, "bud"),
      added(3, "2026-10-02T08:00:00+09:00"), // 翌日は含めない
    ];
    expect(leafCheck(5, obs, [{ count: 1, occurredAt: d("2026-10-01T15:00:00+09:00") }])).toMatchObject({
      cumulative: 7,
      byCheck: 8,
      diff: 1,
    });
  });

  it("同じ時刻の現在の葉数が複数あれば id の大きいほうを使う", () => {
    const at = "2026-10-01T01:00:00Z";
    expect(leafCheck(5, [current(5, at, "a"), current(1, at, "b")], [])).toMatchObject({ observationId: "b", byCheck: 1, needsCheck: true });
  });

  it("現在の葉数の観測がなければ null（警告なし）", () => {
    expect(leafCheck(5, [added(3, "2026-10-01T01:00:00Z")], [])).toBeNull();
    expect(leafCheckWarning(null)).toBeNull();
  });

  it("差が 3 枚以上で確認が必要。2 枚以下は不要（多くても少なくても）", () => {
    expect(leafCheck(20, [current(17, "2026-10-01T01:00:00Z")], [])).toMatchObject({ diff: 3, needsCheck: true });
    expect(leafCheck(20, [current(18, "2026-10-01T01:00:00Z")], [])).toMatchObject({ diff: 2, needsCheck: false });
    expect(leafCheck(7, [current(10, "2026-10-01T01:00:00Z")], [])).toMatchObject({ diff: 3, needsCheck: true });
  });
});

describe("leafCheckWarning", () => {
  it("差が3枚以上なら記録時点の累計と検算の値を含む警告文", () => {
    expect(leafCheckWarning(leafCheck(10, [current(7, "2026-10-01T01:00:00Z")], []))).toBe("確認してください（記録時点の累計 10、検算 7）");
    expect(leafCheckWarning(leafCheck(7, [current(10, "2026-10-01T01:00:00Z")], []))).toBe("確認してください（記録時点の累計 7、検算 10）");
  });

  it("差が2枚以下なら null", () => {
    expect(leafCheckWarning(leafCheck(10, [current(8, "2026-10-01T01:00:00Z")], []))).toBeNull();
  });
});
