import { describe, expect, it } from "vitest";
import { nextMatCodes } from "./code";
import {
  canRemoveMat,
  MAX_REMOVE_REASON_LENGTH,
  parseRemoveReason,
  REMOVE_ALREADY_REMOVED,
  REMOVE_BLOCKED_GROWING,
  REMOVE_BLOCKED_SUCKER,
  removedMatLabel,
} from "./remove";

const active = { status: "active" };

describe("canRemoveMat", () => {
  it("茎が無い株は撤去できる", () => {
    expect(canRemoveMat(active, [])).toEqual({ ok: true });
  });
  it("終わった茎（収穫・芽かき・株分け・喪失）だけなら撤去できる", () => {
    const stems = ["harvested", "removed", "transplanted", "lost"].map((status) => ({ status }));
    expect(canRemoveMat(active, stems)).toEqual({ ok: true });
  });
  it("栽培中（active / flowered）の茎があれば撤去できない", () => {
    expect(canRemoveMat(active, [{ status: "active" }])).toEqual({ ok: false, reason: REMOVE_BLOCKED_GROWING });
    expect(canRemoveMat(active, [{ status: "harvested" }, { status: "flowered" }])).toEqual({
      ok: false,
      reason: REMOVE_BLOCKED_GROWING,
    });
  });
  it("未処理の吸芽があれば撤去できない", () => {
    expect(canRemoveMat(active, [{ status: "harvested" }, { status: "sucker" }])).toEqual({
      ok: false,
      reason: REMOVE_BLOCKED_SUCKER,
    });
  });
  it("栽培中と吸芽の両方があれば、栽培中の理由を出す", () => {
    expect(canRemoveMat(active, [{ status: "sucker" }, { status: "active" }])).toEqual({
      ok: false,
      reason: REMOVE_BLOCKED_GROWING,
    });
  });
  it("撤去済みの株はもう撤去できない", () => {
    expect(canRemoveMat({ status: "removed" }, [])).toEqual({ ok: false, reason: REMOVE_ALREADY_REMOVED });
  });
});

describe("parseRemoveReason", () => {
  it("前後の空白を取る。空なら null", () => {
    expect(parseRemoveReason("  台風で倒れた ")).toEqual({ ok: true, value: "台風で倒れた" });
    expect(parseRemoveReason("   ")).toEqual({ ok: true, value: null });
    expect(parseRemoveReason(null)).toEqual({ ok: true, value: null });
  });
  it("長すぎれば拒否", () => {
    expect(parseRemoveReason("あ".repeat(MAX_REMOVE_REASON_LENGTH + 1)).ok).toBe(false);
    expect(parseRemoveReason("あ".repeat(MAX_REMOVE_REASON_LENGTH)).ok).toBe(true);
  });
});

describe("removedMatLabel", () => {
  it("日付（日本時間）と理由を出す", () => {
    expect(removedMatLabel({ occurred_at: "2026-10-24T16:00:00Z", payload: { reason: "病気" } })).toBe(
      "撤去済み（2026-10-25・病気）",
    );
  });
  it("理由が無ければ日付だけ", () => {
    expect(removedMatLabel({ occurred_at: "2026-10-25T03:00:00+09:00", payload: { reason: null } })).toBe(
      "撤去済み（2026-10-25）",
    );
    expect(removedMatLabel({ occurred_at: "2026-10-25T03:00:00+09:00", payload: {} })).toBe("撤去済み（2026-10-25）");
  });
  it("イベントが無ければ「撤去済み」だけ", () => {
    expect(removedMatLabel(null)).toBe("撤去済み");
  });
});

describe("撤去した株のコードは欠番のまま（採番）", () => {
  it("撤去した株も最大番号の計算に含めるので、そのコードは再利用されない", () => {
    // A-003 は撤去済み。採番に渡す既存のコードは撤去した株も含む（地図に出す株とは別）
    const mats = [
      { code: "A-001", status: "active" },
      { code: "A-002", status: "active" },
      { code: "A-003", status: "removed" },
    ];
    expect(
      nextMatCodes(
        "A",
        mats.map((m) => m.code),
        2,
      ),
    ).toEqual(["A-004", "A-005"]);
  });
});
