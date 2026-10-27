import { describe, expect, it } from "vitest";
import { paramToInput, validatePredictionParams } from "./prediction-params";

describe("validatePredictionParams（予測の設定の検証）", () => {
  it("空欄は null（品種の既定を使う）", () => {
    expect(validatePredictionParams({ baseTemp: "", targetGdd: " " })).toEqual({
      ok: true,
      value: { baseTempC: null, floweringToHarvestGdd: null },
    });
  });
  it("範囲内の値（境界の 5・20、100・5000 を含む）", () => {
    expect(validatePredictionParams({ baseTemp: "5", targetGdd: "100" })).toEqual({
      ok: true,
      value: { baseTempC: 5, floweringToHarvestGdd: 100 },
    });
    expect(validatePredictionParams({ baseTemp: "20", targetGdd: "5000" })).toEqual({
      ok: true,
      value: { baseTempC: 20, floweringToHarvestGdd: 5000 },
    });
    expect(validatePredictionParams({ baseTemp: "13.5", targetGdd: "1100" })).toMatchObject({
      ok: true,
      value: { baseTempC: 13.5, floweringToHarvestGdd: 1100 },
    });
  });
  it("全角の数字も受け付ける", () => {
    expect(validatePredictionParams({ baseTemp: "１２", targetGdd: "" })).toMatchObject({ ok: true, value: { baseTempC: 12 } });
  });
  it("基準温度の範囲外（4.9・20.1）", () => {
    for (const v of ["4.9", "20.1", "-1"]) {
      const r = validatePredictionParams({ baseTemp: v, targetGdd: "" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.baseTemp).toBe("基準温度は 5〜20℃ の範囲で入力してください");
    }
  });
  it("目標積算温度の範囲外", () => {
    const r = validatePredictionParams({ baseTemp: "", targetGdd: "99" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.targetGdd).toBe("目標積算温度は 100〜5,000 ℃・日の範囲で入力してください");
  });
  it("数値でない・小数 2 桁以上", () => {
    const r = validatePredictionParams({ baseTemp: "abc", targetGdd: "900.25" });
    expect(r).toEqual({
      ok: false,
      errors: {
        baseTemp: "基準温度は数値で入力してください",
        targetGdd: "目標積算温度は小数点以下 1 桁までで入力してください",
      },
    });
  });
});

describe("paramToInput", () => {
  it("null は空欄、numeric の文字列は数値の表記に", () => {
    expect(paramToInput(null)).toBe("");
    expect(paramToInput("14.0")).toBe("14");
    expect(paramToInput(13.5)).toBe("13.5");
  });
});
