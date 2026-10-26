import { describe, expect, it } from "vitest";
import { formatJstMonthDayTime, weatherStatusView } from "./status";

const base = { last_error: null, last_success_at: null, last_success_days: null };

describe("weatherStatusView（圃場の詳細の気温の表示）", () => {
  it("未取得なら「取り込み待ち」", () => {
    expect(weatherStatusView(null)).toEqual({ state: "pending", text: "気温: 取り込み待ち" });
  });
  it("最後に成功した取得の日時（日本時間）と日数", () => {
    const row = { ...base, last_run_at: "2026-10-25T20:05:00Z", last_days: 3660, last_success_at: "2026-10-25T20:05:00Z", last_success_days: 3660 };
    expect(weatherStatusView(row)).toEqual({ state: "ok", text: "気温: 最終取得 10月26日 5:05（3,660日分）" });
  });
  it("一部の失敗: 最終取得はその回、失敗の要約と実行日時も返す", () => {
    const row = {
      last_run_at: "2026-10-26T00:00:00Z",
      last_days: 7,
      last_error: "Open-Meteo の過去 API から取得できませんでした（HTTP 503）。欠けた日 23 日",
      last_success_at: "2026-10-26T00:00:00Z",
      last_success_days: 7,
    };
    expect(weatherStatusView(row)).toEqual({
      state: "error",
      text: "気温: 最終取得 10月26日 9:00（7日分）",
      error: "Open-Meteo の過去 API から取得できませんでした（HTTP 503）。欠けた日 23 日",
      errorAt: "10月26日 9:00",
    });
  });
  it("全部失敗した回の後も、最終取得は前に成功した日時のまま", () => {
    const row = {
      last_run_at: "2026-10-27T00:00:00Z",
      last_days: 0,
      last_error: "Open-Meteo の予報 API から取得できませんでした（接続できません）。欠けた日 7 日",
      last_success_at: "2026-10-26T00:00:00Z",
      last_success_days: 8,
    };
    const v = weatherStatusView(row);
    expect(v.text).toBe("気温: 最終取得 10月26日 9:00（8日分）");
    expect(v).toMatchObject({ state: "error", errorAt: "10月27日 9:00" });
  });
  it("一度も成功していなければ「まだ取得できていません」", () => {
    const row = { ...base, last_run_at: "2026-10-26T00:00:00Z", last_days: 0, last_error: "x" };
    expect(weatherStatusView(row)).toMatchObject({ state: "error", text: "気温: まだ取得できていません" });
  });
  it("formatJstMonthDayTime は 0 時を 0:xx と書く", () => {
    expect(formatJstMonthDayTime("2026-10-25T15:07:00Z")).toBe("10月26日 0:07");
  });
});
