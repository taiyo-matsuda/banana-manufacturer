import { describe, expect, it } from "vitest";
import { dueLabel, recordHref, recommendationKindLabel, sortRecommendations, targetLabel } from "./display";
import { resolveRecommendationSettings, validateRecommendationParams } from "./settings";

describe("resolveRecommendationSettings", () => {
  it("行が無い・空欄なら暫定の既定値（袋掛け・摘蕾 14 日、収穫期 7 日）", () => {
    expect(resolveRecommendationSettings(null)).toEqual({ bagAfterDays: 14, harvestWindowDays: 7 });
    expect(resolveRecommendationSettings({ bag_after_days: null, harvest_window_days: null })).toEqual({ bagAfterDays: 14, harvestWindowDays: 7 });
  });
  it("圃場の値で上書き（0 日も有効）", () => {
    expect(resolveRecommendationSettings({ bag_after_days: 10, harvest_window_days: 0 })).toEqual({ bagAfterDays: 10, harvestWindowDays: 0 });
  });
});

describe("validateRecommendationParams", () => {
  it("空欄は null（既定値を使う）。全角数字も受け付ける", () => {
    expect(validateRecommendationParams({ bagAfterDays: "", harvestWindowDays: " " })).toEqual({
      ok: true,
      value: { bagAfterDays: null, harvestWindowDays: null },
    });
    expect(validateRecommendationParams({ bagAfterDays: "１０", harvestWindowDays: "0" })).toEqual({
      ok: true,
      value: { bagAfterDays: 10, harvestWindowDays: 0 },
    });
  });
  it("範囲外・整数でない値はエラー", () => {
    expect(validateRecommendationParams({ bagAfterDays: "0", harvestWindowDays: "31" })).toEqual({
      ok: false,
      errors: {
        bagAfterDays: "袋掛け・摘蕾の日数は 1〜60 日の範囲で入力してください",
        harvestWindowDays: "収穫期の日数は 0〜30 日の範囲で入力してください",
      },
    });
    expect(validateRecommendationParams({ bagAfterDays: "1.5", harvestWindowDays: "-1" })).toEqual({
      ok: false,
      errors: {
        bagAfterDays: "袋掛け・摘蕾の日数は整数（日数）で入力してください",
        harvestWindowDays: "収穫期の日数は整数（日数）で入力してください",
      },
    });
  });
});

describe("表示", () => {
  it("種類の名前", () => {
    expect(["bag", "debud", "harvest_window"].map(recommendationKindLabel)).toEqual(["袋掛け", "摘蕾", "収穫期"]);
  });

  it("「実施した」の行き先: 茎の画面の該当の記録（?record=）", () => {
    expect(recordHref({ kind: "bag", stem_id: "s1", mat_id: "m1" })).toBe("/stems/s1?record=bagged");
    expect(recordHref({ kind: "debud", stem_id: "s1", mat_id: "m1" })).toBe("/stems/s1?record=debudded");
    expect(recordHref({ kind: "harvest_window", stem_id: "s1", mat_id: "m1" })).toBe("/stems/s1?record=harvested");
    expect(recordHref({ kind: "fertilize_after_harvest", stem_id: null, mat_id: "m1" })).toBe("/mats/m1");
  });

  it("対象: 株コードと茎の世代", () => {
    expect(targetLabel({ mat_code: "A-001", generation: 1 })).toBe("A-001 親");
    expect(targetLabel({ mat_code: "A-002", generation: 2 })).toBe("A-002 子");
    expect(targetLabel({ mat_code: "A-003", generation: null })).toBe("A-003");
  });

  it("期限順（期限なしは最後、同じ期限は作られた順）", () => {
    const rows = [
      { id: "c", due_at: null, created_at: "2026-10-01" },
      { id: "b", due_at: "2026-10-30", created_at: "2026-10-02" },
      { id: "a2", due_at: "2026-10-20", created_at: "2026-10-05" },
      { id: "a1", due_at: "2026-10-20", created_at: "2026-10-03" },
    ];
    expect(sortRecommendations(rows).map((r) => r.id)).toEqual(["a1", "a2", "b", "c"]);
  });

  it("期限の文言", () => {
    expect(dueLabel("2026-10-28", "2026-10-28")).toBe("期限 今日（10月28日）");
    expect(dueLabel("2026-10-29", "2026-10-28")).toBe("期限 10月29日（あと 1 日）");
    expect(dueLabel("2026-10-20", "2026-10-28")).toBe("期限 10月20日（8 日過ぎ）");
    expect(dueLabel(null, "2026-10-28")).toBe("期限なし");
  });
});
