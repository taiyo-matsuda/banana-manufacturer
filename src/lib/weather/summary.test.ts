import { describe, expect, it } from "vitest";
import { MAX_SUMMARY_LENGTH, shortReason, summarizeSyncFailures } from "./summary";

describe("summarizeSyncFailures（画面に出す失敗の要約）", () => {
  it("失敗がなければ null", () => {
    expect(summarizeSyncFailures([])).toBeNull();
  });
  it("過去 API の期間ごとの失敗を 1 つの理由と欠けた日数の合計にまとめる", () => {
    const failures = Array.from({ length: 11 }, () => ({
      kind: "archive" as const,
      message: "Open-Meteo が HTTP 503 を返しました: Service Unavailable",
      days: 366,
    }));
    expect(summarizeSyncFailures(failures)).toBe("Open-Meteo の過去 API から取得できませんでした（HTTP 503）。欠けた日 4,026 日");
  });
  it("予報 API と過去 API の両方が落ちたら両方を書く。長くても上限で切る", () => {
    const text = summarizeSyncFailures([
      { kind: "archive", message: "Open-Meteo に接続できません（fetch failed）", days: 30 },
      { kind: "forecast", message: "Open-Meteo に接続できません（fetch failed）", days: 7 },
    ])!;
    expect(text).toBe(
      "Open-Meteo の過去 API から取得できませんでした（接続できません）。欠けた日 30 日。Open-Meteo の予報 API から取得できませんでした（接続できません）。欠けた日 7 日",
    );
    expect(text.length).toBeLessThanOrEqual(MAX_SUMMARY_LENGTH);
  });
  it("DB のエラーなど（other）は短くして足す", () => {
    expect(summarizeSyncFailures([{ kind: "other", message: "取り込みの記録を読めません（timeout）", days: 0 }])).toBe(
      "取り込みの記録を読めません（timeout）",
    );
  });
  it("shortReason", () => {
    expect(shortReason("Open-Meteo が HTTP 400 を返しました: bad")).toBe("HTTP 400");
    expect(shortReason("Open-Meteo の応答の形が想定と違います（hourly.time がない）")).toBe("応答の形が想定と違います");
    expect(shortReason("x".repeat(80))).toBe(`${"x".repeat(60)}…`);
  });
});
