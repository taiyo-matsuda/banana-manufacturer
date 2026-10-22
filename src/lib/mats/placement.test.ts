import { describe, expect, it } from "vitest";
import { isValidDateString, validatePlaceMatsInput } from "./placement";

const base = {
  fieldId: "11111111-1111-4111-8111-111111111111",
  cultivarId: "22222222-2222-4222-8222-222222222222",
  plantedAt: "2026-10-22",
  originType: "tissue_culture",
  points: [{ lat: 26.5, lng: 127.9 }],
};

describe("isValidDateString", () => {
  it("YYYY-MM-DD の実在する日付だけ通す", () => {
    expect(isValidDateString("2026-10-22")).toBe(true);
    expect(isValidDateString("2026-02-30")).toBe(false);
    expect(isValidDateString("2026/10/22")).toBe(false);
    expect(isValidDateString("")).toBe(false);
  });
});

describe("validatePlaceMatsInput", () => {
  it("正しい入力は通る", () => {
    const r = validatePlaceMatsInput(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.originType).toBe("tissue_culture");
  });

  it("初期葉数は省略可（省略 = null）。入れると 0 以上の整数", () => {
    const omitted = validatePlaceMatsInput(base);
    if (omitted.ok) expect(omitted.value.initialLeafCount).toBeNull();
    const empty = validatePlaceMatsInput({ ...base, initialLeafCount: "" });
    if (empty.ok) expect(empty.value.initialLeafCount).toBeNull();
    const given = validatePlaceMatsInput({ ...base, initialLeafCount: "3" });
    expect(given.ok).toBe(true);
    if (given.ok) expect(given.value.initialLeafCount).toBe(3);
    expect(validatePlaceMatsInput({ ...base, initialLeafCount: "-1" })).toEqual({
      ok: false,
      error: "初期葉数は 0 以上の整数で入力してください",
    });
    expect(validatePlaceMatsInput({ ...base, initialLeafCount: "1.5" }).ok).toBe(false);
  });

  it("苗の種類は組織培養 / 購入吸芽のみ（株分けはこの画面では使わない）", () => {
    expect(validatePlaceMatsInput({ ...base, originType: "sucker_purchased" }).ok).toBe(true);
    const r = validatePlaceMatsInput({ ...base, originType: "sucker_transplant" });
    expect(r).toEqual({ ok: false, error: "苗の種類を選んでください" });
  });

  it("品種・圃場の id が不正なら理由を返す", () => {
    expect(validatePlaceMatsInput({ ...base, cultivarId: "" })).toEqual({
      ok: false,
      error: "品種を選んでください",
    });
    expect(validatePlaceMatsInput({ ...base, fieldId: "x" })).toEqual({
      ok: false,
      error: "圃場が不正です",
    });
  });

  it("植え付け日が不正なら理由を返す", () => {
    expect(validatePlaceMatsInput({ ...base, plantedAt: "2026-13-01" }).ok).toBe(false);
  });

  it("株がない・位置が範囲外なら理由を返す", () => {
    expect(validatePlaceMatsInput({ ...base, points: [] })).toEqual({
      ok: false,
      error: "配置する株がありません",
    });
    expect(validatePlaceMatsInput({ ...base, points: [{ lat: 91, lng: 0 }] })).toEqual({
      ok: false,
      error: "株の位置が不正です",
    });
    expect(validatePlaceMatsInput({ ...base, points: [{ lat: NaN, lng: 0 }] }).ok).toBe(false);
  });

  it("上限を超えると理由を返す", () => {
    const points = Array.from({ length: 501 }, () => ({ lat: 26.5, lng: 127.9 }));
    expect(validatePlaceMatsInput({ ...base, points }).ok).toBe(false);
  });
});
