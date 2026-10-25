import { describe, expect, it } from "vitest";
import { offsetLatLng } from "../geo";
import { checkFreePosition, isMatCodeConflictError, MIN_TRANSPLANT_DISTANCE_M, validateTransplantInput } from "./transplant";

const center = { lat: 26.5, lng: 127.9 };

describe("checkFreePosition", () => {
  const mats = [
    { code: "A-001", ...center },
    { code: "A-002", ...offsetLatLng(center, 90, 3) },
  ];

  it("株がなければどこでも空いている", () => {
    expect(checkFreePosition(center, [])).toEqual({ ok: true });
  });

  it("既存の株から 1m 以上離れていれば空いている", () => {
    expect(checkFreePosition(offsetLatLng(center, 0, 1.5), mats)).toEqual({ ok: true });
  });

  it("1m より近ければ、いちばん近い株のコードを添えて断る", () => {
    expect(checkFreePosition(offsetLatLng(center, 90, 2.6), mats)).toEqual({
      ok: false,
      error: "株 A-002 に近すぎます。空いている位置をタップしてください",
    });
    expect(checkFreePosition(center, mats)).toMatchObject({ ok: false });
    expect(MIN_TRANSPLANT_DISTANCE_M).toBe(1);
  });
});

describe("validateTransplantInput", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const valid = {
    eventId: uuid(1),
    stemId: uuid(2),
    toFieldId: uuid(3),
    newMatId: uuid(4),
    newStemId: uuid(5),
    lat: 26.5,
    lng: 127.9,
    code: " AB12-004 ",
    initialLeafCount: "6",
  };

  it("正しい入力はコードの空白を除き、初期葉数を数にする", () => {
    expect(validateTransplantInput(valid)).toEqual({ ok: true, value: { ...valid, code: "AB12-004", initialLeafCount: 6 } });
  });

  it("位置が無ければ地図でのタップを促す", () => {
    expect(validateTransplantInput({ ...valid, lat: null })).toEqual({ ok: false, error: "転出先の位置を地図でタップしてください" });
    expect(validateTransplantInput({ ...valid, lng: Number.NaN })).toMatchObject({ ok: false });
  });

  it("初期葉数は必須", () => {
    expect(validateTransplantInput({ ...valid, initialLeafCount: "" })).toEqual({ ok: false, error: "初期葉数を入力してください" });
  });

  it("id・圃場・コードの形式が違えば断る", () => {
    expect(validateTransplantInput({ ...valid, newMatId: "x" })).toMatchObject({ ok: false });
    expect(validateTransplantInput({ ...valid, toFieldId: "" })).toEqual({ ok: false, error: "転出先の圃場を選んでください" });
    expect(validateTransplantInput({ ...valid, code: "A001" })).toMatchObject({ ok: false });
  });
});

describe("isMatCodeConflictError", () => {
  it("SQLSTATE 23505 かつ hint が mat_code_conflict のときだけ", () => {
    expect(isMatCodeConflictError({ code: "23505", hint: "mat_code_conflict" })).toBe(true);
    expect(isMatCodeConflictError({ code: "23505", hint: null })).toBe(false);
    expect(isMatCodeConflictError({ code: "P0001", hint: "mat_code_conflict" })).toBe(false);
    expect(isMatCodeConflictError(null)).toBe(false);
  });
});
