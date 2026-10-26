import { describe, expect, it } from "vitest";
import { applyOffset, hourlyTimestamp, hourlyToDaily } from "./aggregate";
import type { HourlyPoint } from "./open-meteo";

function day(date: string, temps: (number | null)[], extra: Partial<HourlyPoint> = {}): HourlyPoint[] {
  return temps.map((t, h) => ({
    time: `${date}T${String(h).padStart(2, "0")}:00`,
    temp: t,
    precip: 0,
    wind: 1,
    ...extra,
  }));
}

describe("hourlyToDaily（時間別 → 日次）", () => {
  it("日平均・最低・最高・降水合計・最大風速を出す", () => {
    const temps = Array.from({ length: 24 }, (_, h) => 20 + h * 0.5); // 20.0 〜 31.5、平均 25.75
    const points = day("2026-07-01", temps).map((p, h) => ({
      ...p,
      precip: h === 3 ? 1.2 : h === 15 ? 0.3 : 0,
      wind: h === 10 ? 6.4 : 2,
    }));
    expect(hourlyToDaily(points)).toEqual([
      { date: "2026-07-01", t_mean: 25.8, t_min: 20, t_max: 31.5, precip_mm: 1.5, wind_max_ms: 6.4 },
    ]);
  });

  it("日付の境界は Asia/Tokyo の現地時刻（00:00〜23:00 が同じ日。日をまたいだ 00:00 は翌日）", () => {
    const points = [...day("2026-01-01", Array(24).fill(10)), ...day("2026-01-02", Array(24).fill(20))];
    const daily = hourlyToDaily(points);
    expect(daily.map((d) => [d.date, d.t_mean])).toEqual([
      ["2026-01-01", 10],
      ["2026-01-02", 20],
    ]);
  });

  it("気温が 24 時間そろっていない日（確定前の null・途中で切れた日）は出さない", () => {
    const partial = day("2026-01-02", Array(24).fill(15)).slice(0, 12);
    const withNull = day("2026-01-03", [...Array(23).fill(15), null]);
    const points = [...day("2026-01-01", Array(24).fill(15)), ...partial, ...withNull];
    expect(hourlyToDaily(points).map((d) => d.date)).toEqual(["2026-01-01"]);
  });

  it("降水に欠けた時間があれば降水合計は null、風速が全部 null なら最大風速は null", () => {
    const points = day("2026-01-01", Array(24).fill(15)).map((p, h) => ({
      ...p,
      precip: h === 5 ? null : 0.1,
      wind: null,
    }));
    const [d] = hourlyToDaily(points);
    expect(d.precip_mm).toBeNull();
    expect(d.wind_max_ms).toBeNull();
  });

  it("入力の順序によらず日付の昇順に並べる", () => {
    const points = [...day("2026-01-02", Array(24).fill(1)), ...day("2026-01-01", Array(24).fill(2))];
    expect(hourlyToDaily(points).map((d) => d.date)).toEqual(["2026-01-01", "2026-01-02"]);
  });
});

describe("applyOffset（圃場の気温補正）", () => {
  it("気温にだけ補正を加える（降水・風速・null はそのまま）", () => {
    const points: HourlyPoint[] = [
      { time: "2026-01-01T00:00", temp: 15, precip: 1, wind: 3 },
      { time: "2026-01-01T01:00", temp: null, precip: 0, wind: 2 },
    ];
    expect(applyOffset(points, -1.5)).toEqual([
      { time: "2026-01-01T00:00", temp: 13.5, precip: 1, wind: 3 },
      { time: "2026-01-01T01:00", temp: null, precip: 0, wind: 2 },
    ]);
  });

  it("補正後の値で日次を集計する（日平均・最低・最高に補正が乗る）", () => {
    const daily = hourlyToDaily(applyOffset(day("2026-01-01", Array.from({ length: 24 }, (_, h) => 10 + h)), 0.7));
    expect(daily[0]).toMatchObject({ t_mean: 22.2, t_min: 10.7, t_max: 33.7 });
  });

  it("補正 0 なら値を変えない（元の配列も変えない）", () => {
    const points = day("2026-01-01", Array(24).fill(12));
    const out = applyOffset(points, 0);
    expect(out).toEqual(points);
    expect(out).not.toBe(points);
  });
});

describe("hourlyTimestamp", () => {
  it("現地時刻に +09:00 を付ける", () => {
    expect(hourlyTimestamp("2026-10-26T05:00")).toBe("2026-10-26T05:00:00+09:00");
  });
});
