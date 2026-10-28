import { describe, expect, it } from "vitest";
import { buildNormals, type DailyTemp, type Normals } from "../gdd";
import { eachDate } from "../weather/dates";
import {
  type DamageRef,
  estimateSignature,
  fillNormalsGaps,
  formatRange,
  HARVEST_MODEL_VERSION,
  harvestDisplayFrom,
  harvestEstimateRow,
  harvestSummary,
  type HarvestInput,
  predictHarvest,
  resolveTargetGdd,
  reviewDamages,
} from "./harvest";

// 3 年分（2023〜2025）の日平均がすべて t の平年値。skip の月日はどの年にも入れない（サンプル 0 → null）
function constantNormals(t: number, skip: (md: string) => boolean = () => false, years = [2023, 2024, 2025]): Normals {
  const daily: DailyTemp[] = [];
  for (const y of years) {
    for (const date of eachDate(`${y}-01-01`, `${y}-12-31`)) {
      if (!skip(date.slice(5, 10))) daily.push({ date, tMean: t });
    }
  }
  return buildNormals(daily);
}

// 出蕾 2026-07-01、今日 2026-07-07 → 実績は 07-02〜07-06（5 日）、07-07（今日）からは平年値
const base = (over: Partial<HarvestInput> = {}): HarvestInput => ({
  stemStatus: "flowered",
  stemStartedAt: "2026-01-10",
  budDate: "2026-07-01",
  earliestAt: null,
  today: "2026-07-07",
  daily: eachDate("2026-07-01", "2026-07-07").map((date) => ({ date, tMean: 30 })), // 実績 16/日（出蕾日と今日は数えない）
  normals: constantNormals(24), // 平年値 10/日
  fieldBaseTempC: null,
  cultivarBaseTempC: null,
  fieldTargetGdd: null,
  cultivarTargetGdd: null,
  damages: [],
  ...over,
});

describe("resolveTargetGdd（目標 GDD の解決）", () => {
  it("圃場 × 品種の上書き → 品種の既定 → 900", () => {
    expect(resolveTargetGdd({ fieldOverride: 1000, cultivarDefault: 900 })).toEqual({ value: 1000, source: "field" });
    expect(resolveTargetGdd({ fieldOverride: null, cultivarDefault: 950 })).toEqual({ value: 950, source: "cultivar" });
    expect(resolveTargetGdd({ fieldOverride: null, cultivarDefault: null })).toEqual({ value: 900, source: "default" });
  });
});

describe("predictHarvest（収穫予測日）", () => {
  it("実績 ＋ 今日以降の平年値で目標に達する日。幅は目標の ±10%（手計算）", () => {
    // 実績 5 日 × 16 = 80。残り 820 を平年値 10/日で → 07-07 から 82 日目 = 09-26
    // lower 810: 残り 730 → 73 日目 = 09-17。upper 990: 残り 910 → 91 日目 = 10-05
    const p = predictHarvest(base());
    expect(p.kind).toBe("ok");
    if (p.kind !== "ok") return;
    expect(p.valueDate).toBe("2026-09-26");
    expect(p.lowerDate).toBe("2026-09-17");
    expect(p.upperDate).toBe("2026-10-05");
    expect(p.needsReview).toBe(false);
    expect(p.inputs).toMatchObject({
      bud_date: "2026-07-01",
      earliest_at: null,
      target_gdd: 900,
      target_gdd_source: "default",
      base_temp_c: 14,
      base_temp_source: "default",
      range_ratio: 0.1,
      actual_from: "2026-07-02",
      actual_to: "2026-07-06",
      actual_gdd: 80,
      actual_days: 5,
      actual_missing_days: 0,
      normals_version: "normals-2023-2025",
      normals_filled_days: 0,
      damage: null,
      damage_events: [],
    });
  });

  it("目標 GDD を圃場で上書きすると予測日が変わる（1000 → 残り 920 → 92 日目 = 10-06）", () => {
    const p = predictHarvest(base({ fieldTargetGdd: 1000, cultivarTargetGdd: 900 }));
    expect(p.kind === "ok" && p.valueDate).toBe("2026-10-06");
    expect(p.kind === "ok" && p.inputs.target_gdd_source).toBe("field");
    // 幅: 900 → 82 日目 = 09-26、1100 → 102 日目 = 10-16
    expect(p.kind === "ok" && p.lowerDate).toBe("2026-09-26");
    expect(p.kind === "ok" && p.upperDate).toBe("2026-10-16");
  });

  it("基準温度の上書きは実績と平年値の両方に効く（12℃: 実績 18/日 × 5 = 90、平年値 12/日）", () => {
    // 残り 810 / 12 = 67.5 → 68 日目 = 07-07 + 67 = 09-12
    const p = predictHarvest(base({ fieldBaseTempC: 12 }));
    expect(p.kind === "ok" && p.valueDate).toBe("2026-09-12");
    expect(p.kind === "ok" && p.inputs.actual_gdd).toBe(90);
    expect(p.kind === "ok" && p.inputs.base_temp_source).toBe("field");
  });

  it("出蕾日は確認日を使い、earliest_at は inputs に残すだけ（予測日は変わらない）", () => {
    const a = predictHarvest(base());
    const b = predictHarvest(base({ earliestAt: "2026-06-25" }));
    expect(b.kind === "ok" && b.valueDate).toBe(a.kind === "ok" && a.valueDate);
    expect(b.kind === "ok" && b.inputs.earliest_at).toBe("2026-06-25");
  });

  it("時間別が 24 時間そろった実績の日は時間別で数える", () => {
    // 07-02 を時間別（前半 12 時間 10℃・後半 12 時間 30℃）→ (0 + 16×12)/24 = 8（日平均 30 なら 16）→ 実績 72
    const hourly = [{ date: "2026-07-02", temps: [...Array(12).fill(10), ...Array(12).fill(30)] as number[] }];
    const p = predictHarvest(base({ hourly }));
    expect(p.kind === "ok" && p.inputs.actual_gdd).toBe(72);
    // 残り 828 → 82.8 → 83 日目 = 09-27
    expect(p.kind === "ok" && p.valueDate).toBe("2026-09-27");
  });

  it("実績の気温が欠けた日は平年値で補う（0 にしない）。補った日数を inputs に残す", () => {
    // 07-03・07-04 が欠け → 実績 3 日 × 16 = 48、欠けた 2 日は平年値 10 → 68。残り 832 → 83.2 → 84 日目 = 09-28
    const daily = base().daily.filter((d) => d.date !== "2026-07-03" && d.date !== "2026-07-04");
    const p = predictHarvest(base({ daily }));
    expect(p.kind).toBe("ok");
    if (p.kind !== "ok") return;
    expect(p.inputs.actual_gdd).toBe(48);
    expect(p.inputs.actual_days).toBe(3);
    expect(p.inputs.actual_missing_days).toBe(2);
    expect(p.valueDate).toBe("2026-09-28");
  });

  it("出蕾が今日なら実績はなく、翌日から平年値（900 / 10 = 90 日目）", () => {
    const p = predictHarvest(base({ budDate: "2026-07-07", daily: [] }));
    expect(p.kind === "ok" && p.valueDate).toBe("2026-10-05");
    expect(p.kind === "ok" && p.inputs.actual_gdd).toBe(0);
    expect(p.kind === "ok" && p.inputs.actual_to < p.inputs.actual_from).toBe(true);
  });

  it("実績だけで目標を超えていれば、予測日は過去の日（実績で達した日）", () => {
    // 出蕾 2026-01-01、実績 30℃（16/日）で 06-30 まで → 900 / 16 = 56.25 → 出蕾日 + 57 日 = 02-27
    const daily = eachDate("2026-01-01", "2026-07-07").map((date) => ({ date, tMean: 30 }));
    const p = predictHarvest(base({ budDate: "2026-01-01", daily }));
    expect(p.kind === "ok" && p.valueDate).toBe("2026-02-27");
    // lower 810 / 16 = 50.6 → +51 日 = 02-21、upper 990 / 16 = 61.9 → +62 日 = 03-04
    expect(p.kind === "ok" && p.lowerDate).toBe("2026-02-21");
    expect(p.kind === "ok" && p.upperDate).toBe("2026-03-04");
  });

  it("lost の茎は推定しない。出蕾前の茎も対象外", () => {
    expect(predictHarvest(base({ stemStatus: "lost" }))).toEqual({ kind: "skipped", reason: "lost" });
    expect(predictHarvest(base({ stemStatus: "active", budDate: null }))).toEqual({ kind: "skipped", reason: "not_flowered" });
    expect(predictHarvest(base({ stemStatus: "harvested" }))).toEqual({ kind: "skipped", reason: "not_flowered" });
  });

  describe("被害（7 章）", () => {
    const dmg = (targetType: DamageRef["targetType"], severity: string, date: string, eventId = `e-${targetType}-${date}`): DamageRef => ({
      targetType,
      severity,
      date,
      eventId,
    });

    it("茎の severe の被害は「要確認」（予測日は出す）。inputs.damage = severe", () => {
      const p = predictHarvest(base({ damages: [dmg("stem", "severe", "2026-07-03")] }));
      expect(p.kind).toBe("ok");
      if (p.kind !== "ok") return;
      expect(p.needsReview).toBe(true);
      expect(p.valueDate).toBe("2026-09-26");
      expect(p.inputs.damage).toBe("severe");
      expect(p.inputs.damage_events).toEqual([{ target_type: "stem", event_id: "e-stem-2026-07-03", date: "2026-07-03" }]);
    });

    it("株・圃場の severe の被害（茎の開始日以降）も「要確認」", () => {
      expect(predictHarvest(base({ damages: [dmg("mat", "severe", "2026-03-01")] })).kind === "ok").toBe(true);
      const m = predictHarvest(base({ damages: [dmg("mat", "severe", "2026-03-01")] }));
      const f = predictHarvest(base({ damages: [dmg("field", "severe", "2026-01-10")] }));
      expect(m.kind === "ok" && m.needsReview).toBe(true);
      expect(f.kind === "ok" && f.needsReview).toBe(true);
    });

    it("茎の開始日より前の株・圃場の被害、severe でない被害は要確認にしない", () => {
      const p = predictHarvest(
        base({
          damages: [dmg("field", "severe", "2026-01-09"), dmg("mat", "moderate", "2026-05-01"), dmg("stem", "light", "2026-07-02")],
        }),
      );
      expect(p.kind === "ok" && p.needsReview).toBe(false);
      expect(p.kind === "ok" && p.inputs.damage).toBeNull();
    });

    it("reviewDamages は日付順に並べる", () => {
      const r = reviewDamages([dmg("field", "severe", "2026-05-01"), dmg("stem", "severe", "2025-12-01")], "2026-01-10");
      expect(r.map((d) => d.date)).toEqual(["2025-12-01", "2026-05-01"]);
    });
  });

  describe("平年値が null の日（サンプル 3 年未満）", () => {
    it("平年値の材料がまったく無ければ予測しない（no_normals）", () => {
      const p = predictHarvest(base({ normals: buildNormals([]) }));
      expect(p.kind).toBe("unavailable");
      expect(p.kind === "unavailable" && p.reason).toBe("no_normals");
      expect(p.kind === "unavailable" && p.inputs.unavailable_reason).toBe("no_normals");
    });

    it("7 日以下の欠けは前後の値から直線で補い、補った日数を残す", () => {
      // 08-10〜08-14（5 日）が null。前後とも 24 なので補った値も 24 → 予測日は変わらない
      const normals = constantNormals(24, (md) => md >= "08-10" && md <= "08-14");
      const p = predictHarvest(base({ normals }));
      expect(p.kind === "ok" && p.valueDate).toBe("2026-09-26");
      expect(p.kind === "ok" && p.inputs.normals_filled_days).toBe(5);
    });

    it("7 日を超える欠けに当たったら予測しない（normals_gap、最初の日を残す）", () => {
      const normals = constantNormals(24, (md) => md >= "08-10" && md <= "08-17"); // 8 日
      const p = predictHarvest(base({ normals }));
      expect(p.kind).toBe("unavailable");
      if (p.kind !== "unavailable") return;
      expect(p.reason).toBe("normals_gap");
      expect(p.inputs.unavailable_date).toBe("2026-08-10");
    });

    it("欠けが予測に使わない日（予測の後）なら影響しない", () => {
      const normals = constantNormals(24, (md) => md >= "11-01" && md <= "11-30");
      const p = predictHarvest(base({ normals }));
      expect(p.kind === "ok" && p.valueDate).toBe("2026-09-26");
    });

    it("2 年分しかない（サンプル 3 年未満）なら全日 null → no_normals と同じく予測しない", () => {
      const p = predictHarvest(base({ normals: constantNormals(24, () => false, [2024, 2025]) }));
      expect(p.kind).toBe("unavailable");
    });
  });

  it("平年値がずっと基準温度以下なら目標に達しない（never_reaches）", () => {
    const p = predictHarvest(base({ normals: constantNormals(10) }));
    expect(p.kind === "unavailable" && p.reason).toBe("never_reaches");
  });
});

describe("fillNormalsGaps（平年値の欠けを補う）", () => {
  it("両隣の値から直線で補う", () => {
    // 03-02〜03-04 が null、前（03-01）20、後（03-05）24 → 21, 22, 23
    const daily: DailyTemp[] = [];
    for (const y of [2023, 2024, 2025]) {
      for (const date of eachDate(`${y}-01-01`, `${y}-12-31`)) {
        const md = date.slice(5, 10);
        if (md >= "03-02" && md <= "03-04") continue;
        daily.push({ date, tMean: md <= "03-01" ? 20 : 24 });
      }
    }
    const f = fillNormalsGaps(buildNormals(daily));
    expect(f.byMonthDay.get("03-02")).toBeCloseTo(21, 10);
    expect(f.byMonthDay.get("03-03")).toBeCloseTo(22, 10);
    expect(f.byMonthDay.get("03-04")).toBeCloseTo(23, 10);
    expect([...f.filled].sort()).toEqual(["03-02", "03-03", "03-04"]);
  });

  it("年をまたぐ欠け（12-30〜01-02）も補う", () => {
    const f = fillNormalsGaps(constantNormals(22, (md) => md >= "12-30" || md <= "01-02"));
    expect(f.byMonthDay.get("12-31")).toBeCloseTo(22, 10);
    expect(f.byMonthDay.get("01-01")).toBeCloseTo(22, 10);
    expect(f.filled.size).toBe(4);
  });

  it("全部 null なら何もしない", () => {
    const f = fillNormalsGaps(buildNormals([]));
    expect(f.filled.size).toBe(0);
    expect(f.byMonthDay.get("07-01")).toBeNull();
  });
});

describe("推定の行・署名・表示", () => {
  it("harvestEstimateRow: model_version と inputs 付き。予測できないときは日付 null", () => {
    const ok = predictHarvest(base());
    const na = predictHarvest(base({ normals: buildNormals([]) }));
    if (ok.kind === "skipped" || na.kind === "skipped") throw new Error("unexpected");
    const row = harvestEstimateRow("s1", ok);
    expect(row).toMatchObject({ stem_id: "s1", kind: "harvest_date", value_date: "2026-09-26", model_version: HARVEST_MODEL_VERSION });
    expect(row.inputs.bud_date).toBe("2026-07-01");
    expect(harvestEstimateRow("s1", na)).toMatchObject({ value_date: null, lower_date: null, upper_date: null });
  });

  it("estimateSignature: キーの順に依らず、入力が変われば変わる", () => {
    const ok = predictHarvest(base());
    const changed = predictHarvest(base({ fieldTargetGdd: 1000 }));
    if (ok.kind === "skipped" || changed.kind === "skipped") throw new Error("unexpected");
    const row = harvestEstimateRow("s1", ok);
    const reordered = { ...row, inputs: Object.fromEntries(Object.entries(row.inputs).reverse()) };
    expect(estimateSignature(reordered)).toBe(estimateSignature(row));
    expect(estimateSignature(harvestEstimateRow("s1", changed))).not.toBe(estimateSignature(row));
    // jsonb から読み出した数値（文字列化の違い）も 2 桁で丸めて比べる
    expect(estimateSignature({ ...row, inputs: { ...row.inputs, actual_gdd: 80.000001 } })).toBe(estimateSignature(row));
  });

  it("harvestDisplayFrom / harvestSummary: 「収穫予測: 9月26日ごろ（9月17日〜10月5日）」、要確認", () => {
    const ok = predictHarvest(base({ damages: [{ targetType: "stem", severity: "severe", date: "2026-07-03", eventId: "e" }] }));
    if (ok.kind === "skipped") throw new Error("unexpected");
    const row = { ...harvestEstimateRow("s1", ok), computed_at: "2026-07-07T00:00:00Z" };
    const d = harvestDisplayFrom(row);
    expect(d?.state).toBe("ok");
    if (d?.state !== "ok") return;
    expect(d.needsReview).toBe(true);
    expect(harvestSummary(d)).toBe("収穫予測: 9月26日ごろ（9月17日〜10月5日）");
    expect(harvestDisplayFrom(null)).toBeNull();
  });

  it("harvestDisplayFrom: 予測できなかった行は理由", () => {
    const na = predictHarvest(base({ normals: buildNormals([]) }));
    if (na.kind === "skipped") throw new Error("unexpected");
    const d = harvestDisplayFrom({ ...harvestEstimateRow("s1", na), computed_at: "2026-07-07T00:00:00Z" });
    expect(d).toMatchObject({ state: "unavailable", reason: "no_normals" });
  });

  it("formatRange: 同じ月は日だけ、月をまたげば月も", () => {
    expect(formatRange("2026-11-01", "2026-11-12")).toBe("11月1日〜12日");
    expect(formatRange("2026-10-28", "2026-11-08")).toBe("10月28日〜11月8日");
  });
});
