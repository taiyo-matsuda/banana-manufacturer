import { describe, expect, it } from "vitest";
import { uniqueViolationMessage, validateFieldInput } from "./validation";

const valid = { name: "北の畑", code: "a", lat: "26.5", lng: "127.9" };

describe("validateFieldInput", () => {
  it("正しい入力なら ok。前後の空白を除き、記号は大文字にする", () => {
    const r = validateFieldInput({ ...valid, name: " 北の畑 ", code: " ab1 " });
    expect(r).toEqual({
      ok: true,
      value: { name: "北の畑", code: "AB1", centerLat: 26.5, centerLng: 127.9 },
    });
  });

  it("名前が空なら登録できず理由が出る（完了条件 2）", () => {
    const r = validateFieldInput({ ...valid, name: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.name).toBe("圃場の名前を入力してください");
  });

  it("緯度・経度が未指定なら登録できず理由が出る（完了条件 2）", () => {
    const r = validateFieldInput({ ...valid, lat: "", lng: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.lat).toBe("代表点の緯度を入力してください");
      expect(r.errors.lng).toBe("代表点の経度を入力してください");
    }
  });

  it("数値でない緯度経度は未指定として扱う", () => {
    const r = validateFieldInput({ ...valid, lat: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.lat).toBe("代表点の緯度を入力してください");
  });

  it("10 進小数以外（16 進・指数表記・全角）は未指定として扱う", () => {
    for (const lat of ["0x10", "1e2", "Infinity", "２６.５", "26,5"]) {
      const r = validateFieldInput({ ...valid, lat });
      expect(r.ok, lat).toBe(false);
      if (!r.ok) expect(r.errors.lat, lat).toBe("代表点の緯度を入力してください");
    }
    for (const lat of ["26", "-26.5", "+26.5", ".5", "26."]) {
      expect(validateFieldInput({ ...valid, lat }).ok, lat).toBe(true);
    }
  });

  it("緯度は -90〜90、経度は -180〜180 の範囲", () => {
    const r = validateFieldInput({ ...valid, lat: "90.1", lng: "-180.5" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.lat).toBe("緯度は -90〜90 の範囲で入力してください");
      expect(r.errors.lng).toBe("経度は -180〜180 の範囲で入力してください");
    }
    expect(validateFieldInput({ ...valid, lat: "-90", lng: "180" }).ok).toBe(true);
  });

  it("圃場記号は英数字 1〜4 文字", () => {
    expect(validateFieldInput({ ...valid, code: "" }).ok).toBe(false);
    expect(validateFieldInput({ ...valid, code: "ABCDE" }).ok).toBe(false);
    expect(validateFieldInput({ ...valid, code: "A-1" }).ok).toBe(false);
    expect(validateFieldInput({ ...valid, code: "あ" }).ok).toBe(false);
    expect(validateFieldInput({ ...valid, code: "A1b2" }).ok).toBe(true);
    const r = validateFieldInput({ ...valid, code: "ABCDE" });
    if (!r.ok) expect(r.errors.code).toBe("圃場記号は英数字 1〜4 文字で入力してください");
  });

  it("複数の誤りは同時に返す", () => {
    const r = validateFieldInput({ name: "", code: "", lat: "", lng: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["code", "lat", "lng", "name"]);
  });
});

describe("uniqueViolationMessage", () => {
  it("名前の重複（完了条件 3）", () => {
    expect(
      uniqueViolationMessage({
        code: "23505",
        message: 'duplicate key value violates unique constraint "fields_organization_id_name_key"',
      }),
    ).toBe("同じ名前の圃場がすでにあります");
  });

  it("圃場記号の重複", () => {
    expect(
      uniqueViolationMessage({
        code: "23505",
        message: 'duplicate key value violates unique constraint "fields_organization_id_code_key"',
      }),
    ).toBe("同じ圃場記号の圃場がすでにあります");
  });

  it("どちらか不明な 23505 は汎用の文言", () => {
    expect(uniqueViolationMessage({ code: "23505", message: "" })).toBe(
      "同じ名前または圃場記号の圃場がすでにあります",
    );
  });

  it("23505 以外は null", () => {
    expect(uniqueViolationMessage({ code: "42501", message: "rls" })).toBeNull();
    expect(uniqueViolationMessage({})).toBeNull();
  });
});
