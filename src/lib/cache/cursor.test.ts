import { describe, expect, it } from "vitest";
import {
  advanceCursor,
  compareCursor,
  compareTimestamps,
  cursorFilter,
  hasNextPage,
  isAfterCursor,
  LOOKBACK_MS,
  microsToIso,
  startCursor,
  timestampMicros,
} from "./cursor";

const row = (updated_at: string, id: string) => ({ id, updated_at, organization_id: "o", created_at: updated_at });

describe("timestampMicros / compareTimestamps", () => {
  it("小数の末尾の 0 が省かれた PostgREST の形でもマイクロ秒で比べる", () => {
    // 文字列の比較では "11.2073" と "11.20731" や "11+00:00" の大小を取り違えうる
    expect(compareTimestamps("2026-10-25T23:40:11.2073+00:00", "2026-10-25T23:40:11.20731+00:00")).toBe(-1);
    expect(compareTimestamps("2026-10-25T23:40:11+00:00", "2026-10-25T23:40:11.000001+00:00")).toBe(-1);
    expect(compareTimestamps("2026-10-25T23:40:11.5+00:00", "2026-10-25T23:40:11.500000+00:00")).toBe(0);
    expect(compareTimestamps("2026-10-25T23:40:11.9+00:00", "2026-10-25T23:40:12+00:00")).toBe(-1);
  });

  it("タイムゾーンの表記（Z、+09:00）が違っても同じ時刻は等しい", () => {
    expect(compareTimestamps("2026-10-25T23:40:11.123456Z", "2026-10-26T08:40:11.123456+09:00")).toBe(0);
    expect(timestampMicros("2026-01-01T00:00:00Z")).toBe(Date.parse("2026-01-01T00:00:00Z") * 1000);
  });

  it("microsToIso は元に戻せる（マイクロ秒まで）", () => {
    const ts = "2026-10-25T23:40:11.207301+00:00";
    expect(microsToIso(timestampMicros(ts))).toBe(ts);
  });
});

describe("compareCursor / isAfterCursor", () => {
  it("(updated_at, id) の組で比べる。同時刻なら id", () => {
    const c = { updated_at: "2026-10-25T00:00:00+00:00", id: "b" };
    expect(compareCursor({ updated_at: "2026-10-25T00:00:00+00:00", id: "a" }, c)).toBe(-1);
    expect(compareCursor({ updated_at: "2026-10-25T00:00:00+00:00", id: "c" }, c)).toBe(1);
    expect(compareCursor({ updated_at: "2026-10-25T00:00:00.000001+00:00", id: "a" }, c)).toBe(1);
    expect(isAfterCursor(row("2026-10-25T00:00:00+00:00", "b"), c)).toBe(false);
    expect(isAfterCursor(row("2026-10-25T00:00:00+00:00", "c"), c)).toBe(true);
    expect(isAfterCursor(row("2000-01-01T00:00:00+00:00", "a"), null)).toBe(true);
  });
});

describe("advanceCursor", () => {
  it("ページの最後（最大）の行に進める。前より後ろにしか動かない", () => {
    const rows = [row("2026-10-25T00:00:01+00:00", "x"), row("2026-10-25T00:00:02+00:00", "a"), row("2026-10-25T00:00:02+00:00", "b")];
    expect(advanceCursor("observations", null, rows)).toEqual({ table: "observations", updated_at: "2026-10-25T00:00:02+00:00", id: "b" });
    const later = { table: "observations" as const, updated_at: "2026-10-26T00:00:00+00:00", id: "a" };
    expect(advanceCursor("observations", later, rows)).toBe(later);
    expect(advanceCursor("observations", null, [])).toBeNull();
  });
});

describe("startCursor（開始時に少し戻す）", () => {
  it("LOOKBACK_MS だけ戻し、id は最小にする。カーソルが無ければ null（全件）", () => {
    const c = { table: "events" as const, updated_at: "2026-10-25T00:10:00.5+00:00", id: "zzz" };
    const s = startCursor(c)!;
    expect(timestampMicros(c.updated_at) - timestampMicros(s.updated_at)).toBe(LOOKBACK_MS * 1000);
    expect(s.id).toBe("00000000-0000-0000-0000-000000000000");
    expect(startCursor(null)).toBeNull();
  });
});

describe("cursorFilter（ページの条件）", () => {
  it("updated_at > c または（updated_at = c かつ id > c.id）。値は引用符で囲む。組織の条件は書かない", () => {
    expect(cursorFilter({ updated_at: "2026-10-25T23:40:11.2073+00:00", id: "abc" })).toBe(
      'updated_at.gt."2026-10-25T23:40:11.2073+00:00",and(updated_at.eq."2026-10-25T23:40:11.2073+00:00",id.gt.abc)',
    );
    expect(cursorFilter(null)).toBeNull();
  });

  it("1,000 件ちょうど以上なら次のページを読む", () => {
    expect(hasNextPage(1000)).toBe(true);
    expect(hasNextPage(999)).toBe(false);
    expect(hasNextPage(0)).toBe(false);
  });
});
