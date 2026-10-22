import { describe, expect, it } from "vitest";
import {
  canAddActiveStem,
  countActiveStems,
  INITIAL_LEAF_COUNT_ERROR,
  isMaxActiveStemsError,
  MAX_ACTIVE_STEMS,
  MAX_ACTIVE_STEMS_MESSAGE,
  newActiveStemRow,
  nextGeneration,
  parseInitialLeafCount,
  validateStemInput,
} from "./registration";

describe("countActiveStems / canAddActiveStem", () => {
  it("active と flowered だけを数える", () => {
    const stems = [
      { status: "active" },
      { status: "flowered" },
      { status: "harvested" },
      { status: "sucker" },
      { status: "lost" },
      { status: "removed" },
      { status: "transplanted" },
    ];
    expect(countActiveStems(stems)).toBe(2);
    expect(canAddActiveStem(stems)).toEqual({ ok: true });
  });

  it("3 本（上限）なら登録できず、理由を返す", () => {
    expect(MAX_ACTIVE_STEMS).toBe(3);
    const stems = [{ status: "active" }, { status: "active" }, { status: "flowered" }];
    expect(countActiveStems(stems)).toBe(3);
    expect(canAddActiveStem(stems)).toEqual({ ok: false, reason: MAX_ACTIVE_STEMS_MESSAGE });
  });

  it("収穫済みが何本あっても数えない", () => {
    const stems = [
      { status: "harvested" },
      { status: "harvested" },
      { status: "harvested" },
      { status: "active" },
    ];
    expect(canAddActiveStem(stems).ok).toBe(true);
  });

  it("茎がなければ登録できる", () => {
    expect(canAddActiveStem([])).toEqual({ ok: true });
  });
});

describe("nextGeneration", () => {
  it("茎がなければ親（generation=1、親茎なし）", () => {
    expect(nextGeneration([])).toEqual({ generation: 1, parentStemId: null });
  });

  it("最大の世代 + 1。親茎は最大の世代の茎", () => {
    const stems = [
      { id: "a", generation: 1, started_at: "2026-01-01" },
      { id: "b", generation: 2, started_at: "2026-06-01" },
    ];
    expect(nextGeneration(stems)).toEqual({ generation: 3, parentStemId: "b" });
  });

  it("同じ世代が複数なら started_at の遅い茎を親にする（並び順に依存しない）", () => {
    const stems = [
      { id: "b2", generation: 2, started_at: "2026-08-01" },
      { id: "a", generation: 1, started_at: "2026-01-01" },
      { id: "b1", generation: 2, started_at: "2026-06-01" },
    ];
    expect(nextGeneration(stems)).toEqual({ generation: 3, parentStemId: "b2" });
  });
});

describe("isMaxActiveStemsError", () => {
  it("トリガー stems_max_active のメッセージを判定する", () => {
    expect(
      isMaxActiveStemsError({ message: "mat 1234-abcd already has 3 active stems" }),
    ).toBe(true);
    expect(isMaxActiveStemsError({ message: "duplicate key value" })).toBe(false);
    expect(isMaxActiveStemsError(null)).toBe(false);
    expect(isMaxActiveStemsError({ message: null })).toBe(false);
  });
});

describe("parseInitialLeafCount", () => {
  it("空は指定なし（null）", () => {
    expect(parseInitialLeafCount("")).toEqual({ ok: true, value: null });
    expect(parseInitialLeafCount("  ")).toEqual({ ok: true, value: null });
    expect(parseInitialLeafCount(null)).toEqual({ ok: true, value: null });
    expect(parseInitialLeafCount(undefined)).toEqual({ ok: true, value: null });
  });
  it("0 以上の整数を受け付ける", () => {
    expect(parseInitialLeafCount("0")).toEqual({ ok: true, value: 0 });
    expect(parseInitialLeafCount(" 5 ")).toEqual({ ok: true, value: 5 });
  });
  it("負数・小数・文字は拒否する", () => {
    for (const s of ["-1", "1.5", "abc", "3e2", "１"]) {
      expect(parseInitialLeafCount(s)).toEqual({ ok: false, error: INITIAL_LEAF_COUNT_ERROR });
    }
  });
});

describe("validateStemInput", () => {
  it("植え付け日と初期葉数が正しければ値を返す", () => {
    expect(validateStemInput({ plantedAt: "2026-10-01", initialLeafCount: "4" })).toEqual({
      ok: true,
      value: { plantedAt: "2026-10-01", initialLeafCount: 4 },
    });
  });
  it("初期葉数は必須", () => {
    const r = validateStemInput({ plantedAt: "2026-10-01", initialLeafCount: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.initialLeafCount).toBe("初期葉数を入力してください");
  });
  it("初期葉数が負数ならエラー", () => {
    const r = validateStemInput({ plantedAt: "2026-10-01", initialLeafCount: "-2" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.initialLeafCount).toBe(INITIAL_LEAF_COUNT_ERROR);
  });
  it("植え付け日が不正ならエラー", () => {
    for (const d of ["", "2026-13-01", "2026/10/01", "2026-02-30"]) {
      const r = validateStemInput({ plantedAt: d, initialLeafCount: "3" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.plantedAt).toBeTruthy();
    }
  });
});

describe("newActiveStemRow", () => {
  it("植え付け: status=active、started_at=adopted_at=植え付け日。organization_id は渡さない", () => {
    const row = newActiveStemRow(
      "mat-1",
      { plantedAt: "2026-10-05", initialLeafCount: 3 },
      { generation: 1, parentStemId: null },
    );
    expect(row).toEqual({
      mat_id: "mat-1",
      generation: 1,
      parent_stem_id: null,
      status: "active",
      started_at: "2026-10-05",
      adopted_at: "2026-10-05",
      initial_leaf_count: 3,
    });
    expect("organization_id" in row).toBe(false);
  });
});
