import { describe, expect, it } from "vitest";
import {
  firstStemPlantedAtDiffers,
  isOriginTypeEditable,
  MAT_CODE_MAX,
  matUpdateErrorMessage,
  validateMatEditInput,
} from "./edit";

const CULTIVAR = "0b3c1d2e-1111-4222-8333-944455556666";
const valid = { code: "A-001", cultivarId: CULTIVAR, plantedAt: "2026-09-15", originType: "tissue_culture" };

describe("validateMatEditInput", () => {
  it("正しい入力なら ok", () => {
    expect(validateMatEditInput(valid, "tissue_culture")).toEqual({
      ok: true,
      value: { code: "A-001", cultivarId: CULTIVAR, plantedAt: "2026-09-15", originType: "tissue_culture" },
    });
  });

  it("株コードの前後の空白は取り除いて保存する", () => {
    const r = validateMatEditInput({ ...valid, code: "  A-012 \t" }, "tissue_culture");
    expect(r.ok && r.value.code).toBe("A-012");
  });

  it("株コードが空（空白だけを含む）なら理由が出る", () => {
    for (const code of ["", "   ", "　"]) {
      const r = validateMatEditInput({ ...valid, code }, "tissue_culture");
      expect(r.ok, JSON.stringify(code)).toBe(false);
      if (!r.ok) expect(r.errors.code).toBe("株コードを入力してください");
    }
  });

  it(`株コードは ${MAT_CODE_MAX} 文字まで`, () => {
    expect(validateMatEditInput({ ...valid, code: "A".repeat(MAT_CODE_MAX) }, "tissue_culture").ok).toBe(true);
    const r = validateMatEditInput({ ...valid, code: "A".repeat(MAT_CODE_MAX + 1) }, "tissue_culture");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.code).toBe(`株コードは ${MAT_CODE_MAX} 文字以内で入力してください`);
  });

  it("品種・植え付け日・苗の種類が不正なら項目ごとに理由が出る", () => {
    const r = validateMatEditInput({ code: "A-001", cultivarId: "x", plantedAt: "2026-02-30", originType: "sucker_transplant" }, "tissue_culture");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.cultivarId).toBe("品種を選んでください");
      expect(r.errors.plantedAt).toBe("植え付け日を入力してください");
      // 選べるのは tissue_culture / sucker_purchased だけ（株分けは株分けの操作で作る）
      expect(r.errors.originType).toBe("苗の種類を選んでください");
    }
  });

  it("購入吸芽に変えられる", () => {
    const r = validateMatEditInput({ ...valid, originType: "sucker_purchased" }, "tissue_culture");
    expect(r.ok && r.value.originType).toBe("sucker_purchased");
  });

  it("株分けで作った株は苗の種類を変えない（入力は無視して null = 変更なし）", () => {
    const r = validateMatEditInput({ ...valid, originType: "tissue_culture" }, "sucker_transplant");
    expect(r.ok && r.value.originType).toBeNull();
    const r2 = validateMatEditInput({ ...valid, originType: "" }, "sucker_transplant");
    expect(r2.ok).toBe(true);
  });
});

describe("isOriginTypeEditable", () => {
  it("株分けの株だけ変更不可", () => {
    expect(isOriginTypeEditable("tissue_culture")).toBe(true);
    expect(isOriginTypeEditable("sucker_purchased")).toBe(true);
    expect(isOriginTypeEditable("sucker_transplant")).toBe(false);
  });
});

describe("matUpdateErrorMessage", () => {
  it("unique 違反（圃場内の株コードの重複）を日本語にする", () => {
    expect(
      matUpdateErrorMessage(
        { code: "23505", message: 'duplicate key value violates unique constraint "mats_field_id_code_key"' },
        "A-002",
      ),
    ).toBe("この圃場には株コード「A-002」の株がすでにあります");
  });
  it("品種の FK 違反", () => {
    expect(matUpdateErrorMessage({ code: "23503" }, "A-001")).toBe("選んだ品種が見つかりません。画面を再読み込みしてください");
  });
  it("それ以外は null", () => {
    expect(matUpdateErrorMessage({ code: "42501" }, "A-001")).toBeNull();
  });
});

describe("firstStemPlantedAtDiffers", () => {
  it("最初の茎（generation 1）の started_at と株の植え付け日が違えば true", () => {
    expect(firstStemPlantedAtDiffers("2026-09-20", [{ generation: 1, started_at: "2026-09-15" }])).toBe(true);
  });
  it("同じなら false。茎がなければ false", () => {
    expect(firstStemPlantedAtDiffers("2026-09-15", [{ generation: 1, started_at: "2026-09-15" }])).toBe(false);
    expect(firstStemPlantedAtDiffers("2026-09-15", [])).toBe(false);
  });
  it("2 世代目以降の茎の日付は見ない", () => {
    expect(
      firstStemPlantedAtDiffers("2026-09-15", [
        { generation: 1, started_at: "2026-09-15" },
        { generation: 2, started_at: "2027-01-10" },
      ]),
    ).toBe(false);
  });
});
