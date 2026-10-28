import { describe, expect, it } from "vitest";
import { dueLabel, recordHref, recommendationKindLabel, sortRecommendations, targetLabel } from "./display";
import {
  DEFAULT_RECOMMENDATION_SETTINGS,
  type RecommendationParamsInput,
  resolveRecommendationSettings,
  standardAmountLabel,
  validateRecommendationParams,
} from "./settings";

const input = (over: Partial<RecommendationParamsInput>): RecommendationParamsInput => ({
  bagAfterDays: "",
  harvestWindowDays: "",
  fertilizeAfterHarvestDays: "",
  deadLeavesIntervalDays: "",
  standardAmount: "",
  standardUnit: "kg",
  ...over,
});
const EMPTY_VALUE = {
  bagAfterDays: null,
  harvestWindowDays: null,
  fertilizeAfterHarvestDays: null,
  deadLeavesIntervalDays: null,
  standardAmount: null,
  standardUnit: null,
};

describe("resolveRecommendationSettings", () => {
  it("行が無い・空欄なら暫定の既定値（袋掛け・摘蕾 14 日、収穫期 7 日）", () => {
    expect(resolveRecommendationSettings(null)).toEqual({ ...DEFAULT_RECOMMENDATION_SETTINGS, bagAfterDays: 14, harvestWindowDays: 7 });
    expect(resolveRecommendationSettings({ bag_after_days: null, harvest_window_days: null })).toEqual({ ...DEFAULT_RECOMMENDATION_SETTINGS, bagAfterDays: 14, harvestWindowDays: 7 });
  });
  it("圃場の値で上書き（0 日も有効）", () => {
    expect(resolveRecommendationSettings({ bag_after_days: 10, harvest_window_days: 0 })).toEqual({ ...DEFAULT_RECOMMENDATION_SETTINGS, bagAfterDays: 10, harvestWindowDays: 0 });
  });
});

describe("validateRecommendationParams", () => {
  it("空欄は null（既定値を使う）。全角数字も受け付ける", () => {
    expect(validateRecommendationParams(input({ bagAfterDays: "", harvestWindowDays: " " }))).toEqual({
      ok: true,
      value: { ...EMPTY_VALUE, bagAfterDays: null, harvestWindowDays: null },
    });
    expect(validateRecommendationParams(input({ bagAfterDays: "１０", harvestWindowDays: "0" }))).toEqual({
      ok: true,
      value: { ...EMPTY_VALUE, bagAfterDays: 10, harvestWindowDays: 0 },
    });
  });
  it("範囲外・整数でない値はエラー", () => {
    expect(validateRecommendationParams(input({ bagAfterDays: "0", harvestWindowDays: "31" }))).toEqual({
      ok: false,
      errors: {
        bagAfterDays: "袋掛け・摘蕾の日数は 1〜60 日の範囲で入力してください",
        harvestWindowDays: "収穫期の日数は 0〜30 日の範囲で入力してください",
      },
    });
    expect(validateRecommendationParams(input({ bagAfterDays: "1.5", harvestWindowDays: "-1" }))).toEqual({
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

describe("3-5 の設定（収穫後の追肥の期限・枯葉処理の間隔・標準量）", () => {
  it("既定値: 追肥 7 日、枯葉処理 30 日、標準量なし", () => {
    expect(resolveRecommendationSettings(null)).toMatchObject({ fertilizeAfterHarvestDays: 7, deadLeavesIntervalDays: 30, standardAmount: null });
  });
  it("圃場の値で上書き。標準量は量と単位がそろったときだけ（numeric は文字列で届く）", () => {
    expect(
      resolveRecommendationSettings({
        fertilize_after_harvest_days: 10,
        dead_leaves_interval_days: 21,
        fertilizer_standard_amount: "0.5",
        fertilizer_standard_unit: "kg",
      }),
    ).toMatchObject({ fertilizeAfterHarvestDays: 10, deadLeavesIntervalDays: 21, standardAmount: { amount: 0.5, unit: "kg" } });
    expect(resolveRecommendationSettings({ fertilizer_standard_amount: 2, fertilizer_standard_unit: null }).standardAmount).toBeNull();
  });
  it("標準量の文言: 未設定なら「圃場の標準量を設定してください」", () => {
    expect(standardAmountLabel(null)).toBe("圃場の標準量を設定してください");
    expect(standardAmountLabel({ amount: 0.5, unit: "kg" })).toBe("量: 圃場の標準量 0.5 kg");
    expect(standardAmountLabel({ amount: 200, unit: "g" })).toBe("量: 圃場の標準量 200 g");
  });
  it("入力: 範囲（追肥 1〜60 日、枯葉処理 1〜365 日）", () => {
    expect(validateRecommendationParams(input({ fertilizeAfterHarvestDays: "0", deadLeavesIntervalDays: "366" }))).toEqual({
      ok: false,
      errors: {
        fertilizeAfterHarvestDays: "収穫後の追肥の日数は 1〜60 日の範囲で入力してください",
        deadLeavesIntervalDays: "枯葉処理の間隔は 1〜365 日の範囲で入力してください",
      },
    });
    expect(validateRecommendationParams(input({ fertilizeAfterHarvestDays: "60", deadLeavesIntervalDays: "１" }))).toEqual({
      ok: true,
      value: { ...EMPTY_VALUE, fertilizeAfterHarvestDays: 60, deadLeavesIntervalDays: 1 },
    });
  });
  it("入力: 標準量は空なら未設定（単位も null）。量があれば正の数（小数 3 桁まで）と単位", () => {
    expect(validateRecommendationParams(input({ standardAmount: " ", standardUnit: "g" }))).toEqual({ ok: true, value: EMPTY_VALUE });
    expect(validateRecommendationParams(input({ standardAmount: "１．５", standardUnit: "L" }))).toEqual({
      ok: true,
      value: { ...EMPTY_VALUE, standardAmount: 1.5, standardUnit: "L" },
    });
    expect(validateRecommendationParams(input({ standardAmount: "0", standardUnit: "kg" }))).toEqual({
      ok: false,
      errors: { standardAmount: "標準量は 0 より大きい数（小数 3 桁まで）で入力してください" },
    });
    expect(validateRecommendationParams(input({ standardAmount: "2", standardUnit: "t" }))).toEqual({
      ok: false,
      errors: { standardUnit: "単位を選んでください（kg / g / L / mL）" },
    });
  });
});

describe("3-5 の表示", () => {
  it("種類の名前", () => {
    expect(["fertilize_after_harvest", "remove_dead_leaves", "inspect"].map(recommendationKindLabel)).toEqual(["収穫後の追肥", "枯葉処理", "確認"]);
  });
  it("「実施した」の行き先: 追肥は圃場の施肥の記録（その株だけ）、枯葉処理・確認は茎の画面", () => {
    expect(recordHref({ kind: "fertilize_after_harvest", stem_id: null, mat_id: "m1", field_id: "f1" })).toBe("/fields/f1/fertilize?mat=m1");
    expect(recordHref({ kind: "remove_dead_leaves", stem_id: "s1", mat_id: "m1", field_id: "f1" })).toBe("/stems/s1");
    expect(recordHref({ kind: "inspect", stem_id: "s1", mat_id: "m1", field_id: "f1" })).toBe("/stems/s1");
  });
});
