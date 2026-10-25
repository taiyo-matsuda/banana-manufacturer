import { describe, expect, it } from "vitest";
import {
  AMOUNT_INVALID_MESSAGE,
  buildFertilizePlan,
  defaultFertilizerUnit,
  fertilizedEventRows,
  fertilizedValueText,
  fertilizerSuggestions,
  fertilizeSubmissionKey,
  fertilizeSummaryText,
  findInvalidTargets,
  formatAmount,
  isValidAmountNumber,
  NO_TARGET_MESSAGE,
  parseAmount,
  parseFertilizeDate,
  parseFertilizerName,
  RELOAD_MESSAGE,
  sumAmounts,
  validateFertilizeSubmission,
} from "./fertilize";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const BATCH = "44444444-4444-4444-8444-444444444444";
const FIELD = "55555555-5555-4555-8555-555555555555";
// 2026-10-25 12:00 JST
const NOW = new Date("2026-10-25T03:00:00Z");

describe("parseAmount", () => {
  it("正の数（小数 3 桁まで）を受け付ける", () => {
    expect(parseAmount("1")).toEqual({ ok: true, value: 1 });
    expect(parseAmount(" 0.5 ")).toEqual({ ok: true, value: 0.5 });
    expect(parseAmount("1.125")).toEqual({ ok: true, value: 1.125 });
  });
  it("空は「入力してください」", () => {
    expect(parseAmount("")).toEqual({ ok: false, error: "量を入力してください" });
    expect(parseAmount(null)).toEqual({ ok: false, error: "量を入力してください" });
  });
  it("0 以下・負数・数字以外・小数 4 桁は拒否", () => {
    for (const s of ["0", "0.000", "-1", "abc", "1.2345", "1e3", ".5", "1."]) {
      expect(parseAmount(s)).toEqual({ ok: false, error: AMOUNT_INVALID_MESSAGE });
    }
  });
  it("上限を超えると拒否", () => {
    expect(parseAmount("100001").ok).toBe(false);
    expect(parseAmount("100000").ok).toBe(true);
  });
});

describe("isValidAmountNumber", () => {
  it("正の有限数で小数 3 桁まで", () => {
    expect(isValidAmountNumber(0.5)).toBe(true);
    expect(isValidAmountNumber(1.005)).toBe(true);
    expect(isValidAmountNumber(0)).toBe(false);
    expect(isValidAmountNumber(-1)).toBe(false);
    expect(isValidAmountNumber(1.0005)).toBe(false);
    expect(isValidAmountNumber(Number.NaN)).toBe(false);
    expect(isValidAmountNumber("1")).toBe(false);
    expect(isValidAmountNumber(1_000_000)).toBe(false);
  });
});

describe("parseFertilizerName / parseFertilizeDate", () => {
  it("肥料名は必須で前後の空白を取る", () => {
    expect(parseFertilizerName("  化成肥料 ")).toEqual({ ok: true, value: "化成肥料" });
    expect(parseFertilizerName("   ")).toEqual({ ok: false, error: "肥料名を入力してください" });
    expect(parseFertilizerName("あ".repeat(101)).ok).toBe(false);
  });
  it("日付は YYYY-MM-DD で、未来は拒否（日本時間）", () => {
    expect(parseFertilizeDate("2026-10-25", NOW)).toEqual({ ok: true, value: "2026-10-25" });
    expect(parseFertilizeDate("2026-10-01", NOW).ok).toBe(true);
    expect(parseFertilizeDate("2026-10-26", NOW)).toEqual({ ok: false, error: "未来の日付は記録できません" });
    expect(parseFertilizeDate("2026-02-30", NOW).ok).toBe(false);
    expect(parseFertilizeDate("", NOW).ok).toBe(false);
  });
});

describe("sumAmounts / formatAmount", () => {
  it("小数の誤差なく足す", () => {
    expect(sumAmounts([0.1, 0.2])).toBe(0.3);
    expect(sumAmounts([0.5, 0.5, 0.5, 0.5, 1.2])).toBe(3.2);
    expect(sumAmounts([])).toBe(0);
  });
  it("末尾の 0 を付けずに表示", () => {
    expect(formatAmount(0.5)).toBe("0.5");
    expect(formatAmount(12)).toBe("12");
    expect(formatAmount(0.1 + 0.2)).toBe("0.3");
  });
});

describe("buildFertilizePlan", () => {
  const matIds = [U1, U2, U3];
  it("既定は全株に上の量", () => {
    const plan = buildFertilizePlan({ matIds, excluded: new Set(), overrides: new Map(), baseAmount: "0.5" });
    expect(plan.items).toEqual([
      { matId: U1, amount: 0.5 },
      { matId: U2, amount: 0.5 },
      { matId: U3, amount: 0.5 },
    ]);
    expect(plan.selectedCount).toBe(3);
    expect(plan.total).toBe(1.5);
    expect(plan.baseError).toBeNull();
  });
  it("外した株は含めず、個別に変えた株はその量。上の量を変えると個別に変えていない株が追従する", () => {
    const excluded = new Set([U2]);
    const overrides = new Map([[U3, "1.2"]]);
    const a = buildFertilizePlan({ matIds, excluded, overrides, baseAmount: "0.5" });
    expect(a.items).toEqual([
      { matId: U1, amount: 0.5 },
      { matId: U3, amount: 1.2 },
    ]);
    expect(a.selectedCount).toBe(2);
    expect(a.total).toBe(1.7);
    const b = buildFertilizePlan({ matIds, excluded, overrides, baseAmount: "2" });
    expect(b.items).toEqual([
      { matId: U1, amount: 2 },
      { matId: U3, amount: 1.2 },
    ]);
    expect(b.total).toBe(3.2);
  });
  it("上の量が不正なら、それを使う株があるときだけエラー。合計は null", () => {
    const a = buildFertilizePlan({ matIds, excluded: new Set(), overrides: new Map(), baseAmount: "0" });
    expect(a.baseError).toBe(AMOUNT_INVALID_MESSAGE);
    expect(a.total).toBeNull();
    expect(a.items).toEqual([]);
    const allOverridden = new Map([
      [U1, "1"],
      [U2, "1"],
      [U3, "1"],
    ]);
    const b = buildFertilizePlan({ matIds, excluded: new Set(), overrides: allOverridden, baseAmount: "" });
    expect(b.baseError).toBeNull();
    expect(b.total).toBe(3);
  });
  it("個別の量が不正な株は rowErrors に入り、合計は null", () => {
    const plan = buildFertilizePlan({ matIds, excluded: new Set(), overrides: new Map([[U2, "-1"]]), baseAmount: "1" });
    expect(plan.rowErrors.get(U2)).toBe(AMOUNT_INVALID_MESSAGE);
    expect(plan.total).toBeNull();
    // 外した株の不正な量は問わない
    const excluded = buildFertilizePlan({ matIds, excluded: new Set([U2]), overrides: new Map([[U2, "-1"]]), baseAmount: "1" });
    expect(excluded.rowErrors.size).toBe(0);
    expect(excluded.total).toBe(2);
  });
  it("全て外すと 0 株・合計 0", () => {
    const plan = buildFertilizePlan({ matIds, excluded: new Set(matIds), overrides: new Map(), baseAmount: "1" });
    expect(plan.selectedCount).toBe(0);
    expect(plan.total).toBe(0);
  });
  it("400 株でも速く計算できる", () => {
    const ids = Array.from({ length: 400 }, (_, i) => `id-${i}`);
    const t = performance.now();
    const plan = buildFertilizePlan({ matIds: ids, excluded: new Set(["id-3"]), overrides: new Map([["id-5", "2"]]), baseAmount: "0.25" });
    expect(performance.now() - t).toBeLessThan(50);
    expect(plan.selectedCount).toBe(399);
    expect(plan.total).toBe(sumAmounts([...Array(398).fill(0.25), 2]));
  });
});

describe("validateFertilizeSubmission", () => {
  const valid = {
    batchId: BATCH,
    fieldId: FIELD,
    date: "2026-10-25",
    fertilizer: " 化成肥料 ",
    unit: "kg",
    items: [
      { matId: U1, amount: 0.5 },
      { matId: U2, amount: 1.2 },
    ],
  };
  it("正しい入力は肥料名を整えて通す", () => {
    const r = validateFertilizeSubmission(valid, NOW);
    expect(r).toEqual({ ok: true, value: { ...valid, fertilizer: "化成肥料" } });
  });
  it("肥料名が空・単位が不正・日付が未来なら項目ごとのエラー", () => {
    const r = validateFertilizeSubmission({ ...valid, fertilizer: "", unit: "t", date: "2026-10-26" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.fertilizer).toBe("肥料名を入力してください");
      expect(r.errors.unit).toBe("単位を選んでください");
      expect(r.errors.date).toBe("未来の日付は記録できません");
    }
  });
  it("対象の株が 0 件・量が不正・株の重複・id が不正なら拒否", () => {
    const noItems = validateFertilizeSubmission({ ...valid, items: [] }, NOW);
    expect(!noItems.ok && noItems.errors.targets).toBe(NO_TARGET_MESSAGE);
    const badAmount = validateFertilizeSubmission({ ...valid, items: [{ matId: U1, amount: 0 }] }, NOW);
    expect(!badAmount.ok && badAmount.errors.targets).toBe(AMOUNT_INVALID_MESSAGE);
    const dup = validateFertilizeSubmission({ ...valid, items: [{ matId: U1, amount: 1 }, { matId: U1, amount: 1 }] }, NOW);
    expect(!dup.ok && dup.errors.targets).toBe(RELOAD_MESSAGE);
    const badId = validateFertilizeSubmission({ ...valid, items: [{ matId: "x", amount: 1 }] }, NOW);
    expect(!badId.ok && badId.errors.targets).toBe(RELOAD_MESSAGE);
  });
  it("batch_id・圃場の id が UUID でなければ再読み込みを促す", () => {
    const r = validateFertilizeSubmission({ ...valid, batchId: "x" }, NOW);
    expect(r).toEqual({ ok: false, errors: { form: RELOAD_MESSAGE } });
  });
});

describe("findInvalidTargets", () => {
  it("圃場の撤去していない株にない id を返す", () => {
    expect(findInvalidTargets([U1, U2, U3], new Set([U1, U3]))).toEqual([U2]);
    expect(findInvalidTargets([U1], new Set([U1]))).toEqual([]);
  });
});

describe("候補と既定値", () => {
  it("肥料名の候補は新しい順に重複を除く（前後の空白は同じ扱い、空・不正は除く）", () => {
    const payloads = [
      { fertilizer: "化成肥料" },
      { fertilizer: "化成肥料 " },
      { fertilizer: "堆肥" },
      { fertilizer: "" },
      { fertilizer: 3 },
      null,
      { fertilizer: "化成肥料" },
      { fertilizer: "苦土石灰" },
    ];
    expect(fertilizerSuggestions(payloads)).toEqual(["化成肥料", "堆肥", "苦土石灰"]);
  });
  it("候補は最大件数で打ち切る", () => {
    const payloads = Array.from({ length: 30 }, (_, i) => ({ fertilizer: `肥料${i}` }));
    expect(fertilizerSuggestions(payloads)).toHaveLength(20);
    expect(fertilizerSuggestions(payloads, 2)).toEqual(["肥料0", "肥料1"]);
  });
  it("単位の既定値は前回の単位。なければ kg", () => {
    expect(defaultFertilizerUnit([{ unit: "g" }, { unit: "L" }])).toBe("g");
    expect(defaultFertilizerUnit([{ unit: "t" }, { unit: "mL" }])).toBe("mL");
    expect(defaultFertilizerUnit([])).toBe("kg");
  });
});

describe("イベントの行と表示", () => {
  it("株ごとに fertilized の行を作り、同じ batch_id で束ねる（organization_id は持たない）", () => {
    const rows = fertilizedEventRows(
      {
        batchId: BATCH,
        fieldId: FIELD,
        date: "2026-10-25",
        fertilizer: "化成肥料",
        unit: "kg",
        items: [
          { matId: U1, amount: 0.5 },
          { matId: U2, amount: 1.2 },
        ],
      },
      "2026-10-25T03:00:00.000Z",
      "user-1",
    );
    expect(rows).toEqual([
      {
        type: "fertilized",
        target_type: "mat",
        target_id: U1,
        occurred_at: "2026-10-25T03:00:00.000Z",
        recorded_by: "user-1",
        payload: { fertilizer: "化成肥料", amount: 0.5, unit: "kg", batch_id: BATCH },
      },
      {
        type: "fertilized",
        target_type: "mat",
        target_id: U2,
        occurred_at: "2026-10-25T03:00:00.000Z",
        recorded_by: "user-1",
        payload: { fertilizer: "化成肥料", amount: 1.2, unit: "kg", batch_id: BATCH },
      },
    ]);
    expect(rows.every((r) => !("organization_id" in r))).toBe(true);
  });
  it("履歴の表示は「肥料名 量 単位」", () => {
    expect(fertilizedValueText({ fertilizer: "化成肥料", amount: 0.5, unit: "kg", batch_id: BATCH })).toBe("化成肥料 0.5 kg");
    expect(fertilizedValueText(null)).toBe("");
  });
  it("確認の文言は「N 株に合計 X 単位」", () => {
    expect(fertilizeSummaryText(5, 2.7, "kg")).toBe("5 株に合計 2.7 kg");
  });
});

describe("fertilizeSubmissionKey", () => {
  const base = { fieldId: FIELD, date: "2026-10-25", fertilizer: "化成肥料", unit: "kg", items: [{ matId: U1, amount: 0.5 }] };
  it("同じ内容なら同じ（肥料名の前後の空白は無視）", () => {
    expect(fertilizeSubmissionKey({ ...base, fertilizer: " 化成肥料 " })).toBe(fertilizeSubmissionKey(base));
  });
  it("日付・肥料名・単位・対象・量のどれかが変わると変わる", () => {
    const k = fertilizeSubmissionKey(base);
    expect(fertilizeSubmissionKey({ ...base, date: "2026-10-24" })).not.toBe(k);
    expect(fertilizeSubmissionKey({ ...base, fertilizer: "堆肥" })).not.toBe(k);
    expect(fertilizeSubmissionKey({ ...base, unit: "g" })).not.toBe(k);
    expect(fertilizeSubmissionKey({ ...base, items: [{ matId: U2, amount: 0.5 }] })).not.toBe(k);
    expect(fertilizeSubmissionKey({ ...base, items: [{ matId: U1, amount: 0.6 }] })).not.toBe(k);
    expect(fertilizeSubmissionKey({ ...base, items: [] })).not.toBe(k);
  });
});
