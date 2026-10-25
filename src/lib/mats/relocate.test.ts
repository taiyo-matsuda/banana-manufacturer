import { describe, expect, it } from "vitest";
import { offsetLatLng } from "../geo";
import { applyPositionOverrides, extractMoves, MAX_RELOCATE_MATS, validateRelocateInput } from "./relocate";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const ID3 = "33333333-3333-4333-8333-333333333333";
const FIELD = "44444444-4444-4444-8444-444444444444";
const base = { lat: 26.5, lng: 127.9 };

describe("extractMoves", () => {
  const original = [
    { id: ID1, ...base },
    { id: ID2, ...offsetLatLng(base, 90, 3) },
    { id: ID3, ...offsetLatLng(base, 90, 6) },
  ];

  it("動かした株だけを返す（他の株は含めない）", () => {
    const moved = offsetLatLng(original[1], 0, 2);
    const current = new Map(original.map((m) => [m.id, { lat: m.lat, lng: m.lng }]));
    current.set(ID2, moved);
    expect(extractMoves(original, current)).toEqual([{ matId: ID2, lat: moved.lat, lng: moved.lng }]);
  });

  it("ごく小さい移動（5cm 未満）は動かしていないとみなす", () => {
    const current = new Map([[ID1, offsetLatLng(base, 0, 0.01)]]);
    expect(extractMoves(original, current)).toEqual([]);
  });

  it("元の一覧に無い id・位置が無い株は無視する。順は元の一覧の順", () => {
    const p3 = offsetLatLng(original[2], 180, 1);
    const p1 = offsetLatLng(base, 180, 1);
    const current = new Map([
      [ID3, p3],
      ["zzz", base],
      [ID1, p1],
    ]);
    expect(extractMoves(original, current).map((m) => m.matId)).toEqual([ID1, ID3]);
  });

  it("位置が数でなければ無視する", () => {
    const current = new Map([[ID1, { lat: Number.NaN, lng: 127 }]]);
    expect(extractMoves(original, current)).toEqual([]);
  });
});

describe("validateRelocateInput", () => {
  const move = { matId: ID1, lat: 26.5, lng: 127.9 };

  it("正しい入力はそのまま通す", () => {
    expect(validateRelocateInput({ fieldId: FIELD, moves: [move] })).toEqual({
      ok: true,
      value: { fieldId: FIELD, moves: [move] },
    });
  });
  it("動かした株が無ければ拒否", () => {
    expect(validateRelocateInput({ fieldId: FIELD, moves: [] })).toEqual({ ok: false, error: "動かした株がありません" });
  });
  it("圃場・株の id が不正なら拒否", () => {
    expect(validateRelocateInput({ fieldId: "x", moves: [move] }).ok).toBe(false);
    expect(validateRelocateInput({ fieldId: FIELD, moves: [{ ...move, matId: "x" }] }).ok).toBe(false);
  });
  it("同じ株が 2 回あれば拒否", () => {
    expect(validateRelocateInput({ fieldId: FIELD, moves: [move, { ...move, lat: 26.6 }] }).ok).toBe(false);
  });
  it("位置が範囲外・数でなければ拒否", () => {
    expect(validateRelocateInput({ fieldId: FIELD, moves: [{ ...move, lat: 91 }] }).ok).toBe(false);
    expect(validateRelocateInput({ fieldId: FIELD, moves: [{ ...move, lng: Number.POSITIVE_INFINITY }] }).ok).toBe(false);
    expect(validateRelocateInput({ fieldId: FIELD, moves: [{ ...move, lat: "26" as unknown as number }] }).ok).toBe(false);
  });
  it("上限を超えたら拒否", () => {
    const many = Array.from({ length: MAX_RELOCATE_MATS + 1 }, (_, i) => ({
      matId: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
      lat: 26.5,
      lng: 127.9,
    }));
    expect(validateRelocateInput({ fieldId: FIELD, moves: many }).ok).toBe(false);
  });
  it("余分な項目は落とす", () => {
    const r = validateRelocateInput({ fieldId: FIELD, moves: [{ ...move, code: "A-001" } as never] });
    expect(r.ok && r.value.moves[0]).toEqual(move);
  });
});

describe("applyPositionOverrides", () => {
  it("確定済みの位置を重ね、他の株はそのまま", () => {
    const mats = [
      { id: ID1, code: "A-001", ...base },
      { id: ID2, code: "A-002", lat: 26.6, lng: 128 },
    ];
    const out = applyPositionOverrides(mats, new Map([[ID2, { lat: 1, lng: 2 }]]));
    expect(out).toEqual([mats[0], { id: ID2, code: "A-002", lat: 1, lng: 2 }]);
    expect(mats[1].lat).toBe(26.6);
  });
});
