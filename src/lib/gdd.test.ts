import { describe, expect, it } from "vitest";
import {
  accumulateGdd,
  buildNormals,
  dailyGdd,
  type DailyTemp,
  formatTempC,
  normalFor,
  normalsVersionLabel,
  resolveBaseTemp,
  stemGdd,
  stemGddPeriod,
} from "./gdd";

const hours = (...values: number[]) => values;
// 24 時間のうち、前半 12 時間が a、後半 12 時間が b
const halfDay = (a: number, b: number) => [...Array(12).fill(a), ...Array(12).fill(b)] as number[];

describe("dailyGdd（日次 GDD）", () => {
  it("日平均だけの日: max(0, 日平均 − 基準)", () => {
    expect(dailyGdd({ tMean: 20 }, 14)).toEqual({ gdd: 6, method: "daily" });
    expect(dailyGdd({ tMean: 14.5 }, 14)?.gdd).toBeCloseTo(0.5, 10);
  });
  it("基準温度ちょうどは 0、下回っても 0（負にしない）", () => {
    expect(dailyGdd({ tMean: 14 }, 14)).toEqual({ gdd: 0, method: "daily" });
    expect(dailyGdd({ tMean: 10 }, 14)).toEqual({ gdd: 0, method: "daily" });
    expect(dailyGdd({ tMean: 13.9 }, 14)).toEqual({ gdd: 0, method: "daily" });
  });
  it("時間別が 24 時間そろった日: 時間ごとに 0 で切ってから平均", () => {
    // 前半 12 時間 10℃（0）、後半 12 時間 20℃（6）→ (0×12 + 6×12) / 24 = 3
    // 日平均で計算すると max(0, 15 − 14) = 1 になる（冬の日較差が大きい日は時間別のほうが大きい）
    expect(dailyGdd({ tMean: 15, hourlyTemps: halfDay(10, 20) }, 14)).toEqual({ gdd: 3, method: "hourly" });
  });
  it("時間別の全時間が基準ちょうど・以下なら 0", () => {
    expect(dailyGdd({ tMean: 14, hourlyTemps: Array(24).fill(14) }, 14)).toEqual({ gdd: 0, method: "hourly" });
    expect(dailyGdd({ tMean: 12, hourlyTemps: halfDay(10, 14) }, 14)).toEqual({ gdd: 0, method: "hourly" });
  });
  it("時間別が 24 時間そろわない日は日平均で計算する", () => {
    expect(dailyGdd({ tMean: 18, hourlyTemps: hours(20, 20, 20) }, 14)).toEqual({ gdd: 4, method: "daily" });
  });
  it("時間別が 24 時間あれば日平均が無くても計算する", () => {
    expect(dailyGdd({ tMean: null, hourlyTemps: Array(24).fill(16) }, 14)).toEqual({ gdd: 2, method: "hourly" });
  });
  it("どちらも無い日は null（欠けた日）", () => {
    expect(dailyGdd({ tMean: null }, 14)).toBeNull();
    expect(dailyGdd({ tMean: null, hourlyTemps: hours(20) }, 14)).toBeNull();
  });
  it("基準温度が変われば値も変わる", () => {
    expect(dailyGdd({ tMean: 20 }, 10)?.gdd).toBe(10);
    expect(dailyGdd({ tMean: 20, hourlyTemps: halfDay(10, 20) }, 10)?.gdd).toBe(5);
  });
});

describe("accumulateGdd（期間の積算）", () => {
  const daily: DailyTemp[] = [
    { date: "2026-07-01", tMean: 30 }, // 開始日（含めない）: 16
    { date: "2026-07-02", tMean: 24 }, // 10
    { date: "2026-07-03", tMean: 14 }, // 0（ちょうど基準）
    { date: "2026-07-04", tMean: 26.5 }, // 12.5
    { date: "2026-07-05", tMean: 20 }, // 終了日（含む）: 6
    { date: "2026-07-06", tMean: 40 }, // 期間の外
  ];

  it("開始日の翌日から終了日まで（開始日を含まず、終了日を含む）", () => {
    const r = accumulateGdd({ startDate: "2026-07-01", endDate: "2026-07-05", daily, baseTempC: 14 });
    expect(r.total).toBeCloseTo(10 + 0 + 12.5 + 6, 10);
    expect(r).toMatchObject({ from: "2026-07-02", to: "2026-07-05", days: 4, countedDays: 4, missingDays: 0, dailyDays: 4 });
  });
  it("開始日 = 終了日なら空（0）", () => {
    const r = accumulateGdd({ startDate: "2026-07-05", endDate: "2026-07-05", daily, baseTempC: 14 });
    expect(r).toMatchObject({ total: 0, days: 0, missingDays: 0 });
  });
  it("終了日が開始日より前でも空（0）", () => {
    const r = accumulateGdd({ startDate: "2026-07-05", endDate: "2026-07-04", daily, baseTempC: 14 });
    expect(r).toMatchObject({ total: 0, days: 0 });
  });
  it("欠けた日は数えず、欠けた日数と日付を返す", () => {
    const withGap = daily.filter((d) => d.date !== "2026-07-04");
    const r = accumulateGdd({ startDate: "2026-07-01", endDate: "2026-07-05", daily: withGap, baseTempC: 14 });
    expect(r.total).toBeCloseTo(10 + 0 + 6, 10);
    expect(r).toMatchObject({ days: 4, countedDays: 3, missingDays: 1, missingDates: ["2026-07-04"] });
  });
  it("日平均が null の行も欠けた日", () => {
    const r = accumulateGdd({
      startDate: "2026-07-01",
      endDate: "2026-07-02",
      daily: [{ date: "2026-07-02", tMean: null }],
      baseTempC: 14,
    });
    expect(r).toMatchObject({ total: 0, missingDays: 1 });
  });
  it("時間別がある日は時間別、ない日は日平均で計算して合計する", () => {
    const r = accumulateGdd({
      startDate: "2026-01-10",
      endDate: "2026-01-12",
      daily: [
        { date: "2026-01-11", tMean: 15 }, // 時間別あり: 3（日平均なら 1）
        { date: "2026-01-12", tMean: 16 }, // 時間別なし: 2
      ],
      hourly: [
        { date: "2026-01-11", temps: halfDay(10, 20) },
        { date: "2026-01-13", temps: Array(24).fill(30) }, // 期間の外
      ],
      baseTempC: 14,
    });
    expect(r.total).toBeCloseTo(3 + 2, 10);
    expect(r).toMatchObject({ hourlyDays: 1, dailyDays: 1, countedDays: 2 });
  });
  it("月・年をまたぐ期間", () => {
    const r = accumulateGdd({
      startDate: "2025-12-30",
      endDate: "2026-01-02",
      daily: [
        { date: "2025-12-31", tMean: 18 },
        { date: "2026-01-01", tMean: 17 },
        { date: "2026-01-02", tMean: 16 },
      ],
      baseTempC: 14,
    });
    expect(r.total).toBeCloseTo(4 + 3 + 2, 10);
    expect(r.days).toBe(3);
  });
  it("基準温度を変えると積算も変わる", () => {
    const at14 = accumulateGdd({ startDate: "2026-07-01", endDate: "2026-07-05", daily, baseTempC: 14 }).total;
    const at12 = accumulateGdd({ startDate: "2026-07-01", endDate: "2026-07-05", daily, baseTempC: 12 }).total;
    // 4 日とも 12℃ を上回るので 1 日 2 ずつ増える
    expect(at12 - at14).toBeCloseTo(8, 10);
  });
});

// 平年値の材料を作る: years の各年の 月日 → 値
function material(entries: Record<string, number>, years: number[]): DailyTemp[] {
  const out: DailyTemp[] = [];
  for (const y of years) for (const [md, v] of Object.entries(entries)) out.push({ date: `${y}-${md}`, tMean: v + (y - years[0]) });
  return out;
}

describe("buildNormals（平年値）", () => {
  it("同じ月日の日平均の平均", () => {
    // 2016〜2025 の 10 年、7/1 は 28, 29, …, 37 → 平均 32.5
    const n = buildNormals(material({ "07-01": 28 }, [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]));
    expect(normalFor(n, "2026-07-01")).toBeCloseTo(32.5, 10);
    expect(n.version).toEqual({ fromYear: 2016, toYear: 2025, years: 10 });
    expect(normalsVersionLabel(n.version)).toBe("normals-2016-2025");
  });
  it("手計算: 3 年分の 1/15（16.2, 17.0, 15.5）→ 16.233…", () => {
    const n = buildNormals([
      { date: "2023-01-15", tMean: 16.2 },
      { date: "2024-01-15", tMean: 17.0 },
      { date: "2025-01-15", tMean: 15.5 },
    ]);
    expect(normalFor(n, "2026-01-15")).toBeCloseTo((16.2 + 17.0 + 15.5) / 3, 10);
  });
  it("サンプルが 3 年未満の月日は null（3 年ちょうどは値あり）", () => {
    const two = buildNormals(material({ "08-10": 30 }, [2024, 2025]));
    expect(normalFor(two, "2026-08-10")).toBeNull();
    const three = buildNormals(material({ "08-10": 30 }, [2023, 2024, 2025]));
    expect(normalFor(three, "2026-08-10")).toBeCloseTo(31, 10);
    // 材料に無い月日も null
    expect(normalFor(three, "2026-08-11")).toBeNull();
  });
  it("日平均が null の行はサンプルにしない", () => {
    const n = buildNormals([
      { date: "2023-05-01", tMean: 20 },
      { date: "2024-05-01", tMean: null },
      { date: "2025-05-01", tMean: 22 },
    ]);
    expect(normalFor(n, "2026-05-01")).toBeNull();
  });
  it("2/29: うるう年はその年の 2/29、そうでない年は 2/28 と 3/1 の平均を 1 年分のサンプルにする", () => {
    const n = buildNormals([
      // 2023（平年）: (16 + 18) / 2 = 17
      { date: "2023-02-28", tMean: 16 },
      { date: "2023-03-01", tMean: 18 },
      // 2024（うるう年）: 2/29 = 20（2/28・3/1 の平均 15 は使わない）
      { date: "2024-02-28", tMean: 14 },
      { date: "2024-02-29", tMean: 20 },
      { date: "2024-03-01", tMean: 16 },
      // 2025（平年）: (17 + 19) / 2 = 18
      { date: "2025-02-28", tMean: 17 },
      { date: "2025-03-01", tMean: 19 },
    ]);
    // (17 + 20 + 18) / 3
    expect(normalFor(n, "2028-02-29")).toBeCloseTo(55 / 3, 10);
    // 2/28 と 3/1 は 2/29 の値を含まない
    expect(normalFor(n, "2026-02-28")).toBeCloseTo((16 + 14 + 17) / 3, 10);
    expect(normalFor(n, "2026-03-01")).toBeCloseTo((18 + 16 + 19) / 3, 10);
  });
  it("2/29: 2/28 か 3/1 の片方しか無い年はサンプルにしない（3 年未満なら null）", () => {
    const n = buildNormals([
      { date: "2023-02-28", tMean: 16 },
      { date: "2023-03-01", tMean: 18 },
      { date: "2024-02-28", tMean: 16 },
      { date: "2025-02-28", tMean: 16 },
      { date: "2025-03-01", tMean: 18 },
    ]);
    expect(normalFor(n, "2028-02-29")).toBeNull();
  });
  it("材料が空なら版は null、すべての月日が null", () => {
    const n = buildNormals([]);
    expect(n.version).toBeNull();
    expect(normalsVersionLabel(n.version)).toBeNull();
    expect(n.byMonthDay.size).toBe(366);
    expect([...n.byMonthDay.values()].every((v) => v === null)).toBe(true);
  });
});

describe("resolveBaseTemp（基準温度の解決）", () => {
  it("圃場 × 品種の上書きがあればそれ", () => {
    expect(resolveBaseTemp({ fieldOverride: 12.5, cultivarDefault: 14 })).toEqual({ value: 12.5, source: "field" });
  });
  it("上書きが無ければ品種の既定", () => {
    expect(resolveBaseTemp({ fieldOverride: null, cultivarDefault: 13 })).toEqual({ value: 13, source: "cultivar" });
  });
  it("どちらも無ければ 14℃", () => {
    expect(resolveBaseTemp({ fieldOverride: undefined, cultivarDefault: null })).toEqual({ value: 14, source: "default" });
  });
});

describe("stemGddPeriod / stemGdd（茎の画面の表示）", () => {
  const daily: DailyTemp[] = [
    { date: "2026-10-20", tMean: 30 }, // 出蕾日（含めない）
    { date: "2026-10-21", tMean: 24.4 }, // 10.4
    { date: "2026-10-22", tMean: 22.2 }, // 8.2
    { date: "2026-10-23", tMean: 25 }, // 11
    // 10-24 欠け
    { date: "2026-10-25", tMean: 20 }, // 6
    { date: "2026-10-26", tMean: 21 }, // 7（昨日）
    { date: "2026-10-27", tMean: 40 }, // 今日（まだ日次は無いはずだが、あっても数えない）
  ];
  const base = {
    budDate: "2026-10-20",
    today: "2026-10-27",
    harvestedAt: null,
    endedAt: null,
    daily,
    fieldBaseTempC: null,
    cultivarBaseTempC: 14,
    weatherEverSynced: true,
  };

  it("栽培中: 出蕾から今日までの日数、積算は出蕾の翌日〜昨日", () => {
    expect(stemGddPeriod(base)).toEqual({ endDate: "2026-10-27", accumulateTo: "2026-10-26", ended: null });
    const g = stemGdd(base);
    expect(g.elapsedDays).toBe(7);
    expect(g.total).toBeCloseTo(10.4 + 8.2 + 11 + 6 + 7, 10);
    expect(g.rounded).toBe(43); // 42.6 → 43
    expect(g.missingDays).toBe(1);
    expect(g).toMatchObject({ baseTempC: 14, baseTempSource: "cultivar", notImported: false, accumulatedTo: "2026-10-26" });
  });
  it("圃場 × 品種の基準温度で変わる（12℃: 1 日 2 ずつ増える）", () => {
    const g = stemGdd({ ...base, fieldBaseTempC: 12 });
    expect(g.total).toBeCloseTo(42.6 + 2 * 5, 10);
    expect(g).toMatchObject({ rounded: 53, baseTempC: 12, baseTempSource: "field" });
  });
  it("収穫した茎は収穫日まで（収穫日を含む）", () => {
    const g = stemGdd({ ...base, harvestedAt: "2026-10-23" });
    expect(g).toMatchObject({ endDate: "2026-10-23", ended: "harvested", elapsedDays: 3, missingDays: 0 });
    expect(g.total).toBeCloseTo(10.4 + 8.2 + 11, 10);
  });
  it("出蕾が今日なら 0 日・0", () => {
    const g = stemGdd({ ...base, budDate: "2026-10-27" });
    expect(g).toMatchObject({ elapsedDays: 0, total: 0, missingDays: 0, notImported: false });
  });
  it("一度も取り込まれず気温の行も無い圃場は notImported", () => {
    expect(stemGdd({ ...base, daily: [], weatherEverSynced: false }).notImported).toBe(true);
    // 取り込みの記録が無くても気温の行があれば計算できる
    expect(stemGdd({ ...base, weatherEverSynced: false }).notImported).toBe(false);
    // 取り込みは成功したが期間の気温が無い → 欠けた日として出す
    const g = stemGdd({ ...base, daily: [] });
    expect(g).toMatchObject({ notImported: false, missingDays: 6 });
  });
});

describe("formatTempC", () => {
  it("整数はそのまま、小数は 1 桁", () => {
    expect(formatTempC(14)).toBe("14");
    expect(formatTempC(13.5)).toBe("13.5");
  });
});
