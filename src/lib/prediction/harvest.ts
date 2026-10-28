// 収穫予測日（prediction.md 2・7 章、3-3）。UI・DB に依存しない純粋関数。
//
// 予測日 = 出蕾日の翌日から積算した GDD が目標 GDD に達する最初の日。
// - 出蕾日の翌日〜昨日（actualTo）は実績（src/lib/gdd.ts の dailyGdd。時間別が 24 時間そろった日は時間別）
//   - 実績の気温が欠けた日は、その日の平年値で補う（0 として足すと予測が遅れる方向に偏るため）。補った日数を inputs に残す
// - 実績の翌日（通常は今日）から先は平年値（日平均 − 基準温度、0 未満は 0）。今日の日次はまだ取り込まれていないので、今日も平年値で数える
// - 幅: 目標 GDD の ±10%（0.9 倍に達する日 = lower_date、1.1 倍に達する日 = upper_date）
// - 平年値が null の月日（サンプル 3 年未満）: 前後の値のある月日から直線で補う（年をまたいで円環で探す）。
//   ただし 7 日を超えて続く欠け（補うと誤差が大きい・材料の取り込みが進んでいない）は補わず、その日を使う予測は出さない
//   （unavailable、理由 normals_gap）。平年値の材料がまったく無いときも出さない（理由 no_normals）
// - 被害（7 章）: 茎が lost なら推定しない（skipped）。茎の severe の被害、または茎の開始日以降に起きた
//   その株・圃場の severe の被害があれば「要確認」（inputs.damage = "severe"、needs_review）
// - 出蕾日は確認日（stems.bud_emerged_at）。earliest_at は inputs に残すだけ。出蕾時の累計葉数は使わない
import {
  type BaseTempSource,
  DEFAULT_TARGET_GDD,
  dailyGdd,
  type DailyTemp,
  type HourlyDay,
  type Normals,
  normalsVersionLabel,
  resolveBaseTemp,
} from "../gdd";
import { addDays, eachDate } from "../weather/dates";

export const HARVEST_MODEL_VERSION = "harvest-gdd-v1";
export const HARVEST_RANGE_RATIO = 0.1;
// 平年値の欠け（null の月日）をこの日数まで前後から補う
export const NORMALS_MAX_GAP_DAYS = 7;
// 出蕾からこの日数で目標に達しなければ予測しない（平年値がずっと基準温度以下など）
export const PROJECTION_MAX_DAYS = 730;

export type TargetGddSource = "field" | "cultivar" | "default";

export function resolveTargetGdd(input: {
  fieldOverride: number | null | undefined;
  cultivarDefault: number | null | undefined;
}): { value: number; source: TargetGddSource } {
  if (input.fieldOverride !== null && input.fieldOverride !== undefined) return { value: Number(input.fieldOverride), source: "field" };
  if (input.cultivarDefault !== null && input.cultivarDefault !== undefined)
    return { value: Number(input.cultivarDefault), source: "cultivar" };
  return { value: DEFAULT_TARGET_GDD, source: "default" };
}

// ---------------------------------------------------------------------------
// 平年値の欠けを補う

export type FilledNormals = {
  // 月日（MM-DD）→ 平年の日平均。補えなかった月日は null
  byMonthDay: ReadonlyMap<string, number | null>;
  // 前後から補った月日
  filled: ReadonlySet<string>;
};

// 全 366 の月日（01-01〜12-31、02-29 を含む）を年の順に
const ALL_MONTH_DAYS = eachDate("2000-01-01", "2000-12-31").map((d) => d.slice(5, 10));

// null の月日の連続（年をまたいで円環）が maxGap 日以下なら、両隣の値のある月日から直線で補う
export function fillNormalsGaps(normals: Normals, maxGap: number = NORMALS_MAX_GAP_DAYS): FilledNormals {
  const n = ALL_MONTH_DAYS.length;
  const values = ALL_MONTH_DAYS.map((md) => normals.byMonthDay.get(md) ?? null);
  const out = new Map<string, number | null>(ALL_MONTH_DAYS.map((md, i) => [md, values[i]]));
  const filled = new Set<string>();
  if (values.every((v) => v === null)) return { byMonthDay: out, filled };

  // 値のある月日から始めて 1 周する
  const start = values.findIndex((v) => v !== null);
  let i = 0;
  while (i < n) {
    const idx = (start + i) % n;
    if (values[idx] !== null) {
      i++;
      continue;
    }
    // idx から始まる null の連続
    let len = 0;
    while (len < n && values[(start + i + len) % n] === null) len++;
    if (len <= maxGap) {
      const before = values[(start + i - 1 + n) % n] as number;
      const after = values[(start + i + len) % n] as number;
      for (let k = 0; k < len; k++) {
        const md = ALL_MONTH_DAYS[(start + i + k) % n];
        out.set(md, before + ((after - before) * (k + 1)) / (len + 1));
        filled.add(md);
      }
    }
    i += len;
  }
  return { byMonthDay: out, filled };
}

// ---------------------------------------------------------------------------
// 被害（7 章）

export type DamageRef = {
  targetType: "stem" | "mat" | "field";
  eventId: string;
  date: string; // 起きた日（日本時間 YYYY-MM-DD）
  severity: string;
};

// 要確認にする被害: 茎の severe、または茎の開始日以降に起きた株・圃場の severe（訂正済みは呼び出し側で除く）。
// 株・圃場の被害は、茎が始まる前のものはその茎に関係しないので数えない
export function reviewDamages(damages: readonly DamageRef[], stemStartedAt: string): DamageRef[] {
  return damages
    .filter((d) => d.severity === "severe" && (d.targetType === "stem" || d.date >= stemStartedAt))
    .sort((a, b) => a.date.localeCompare(b.date) || a.eventId.localeCompare(b.eventId));
}

// ---------------------------------------------------------------------------
// 予測

export type HarvestInputs = {
  bud_date: string;
  earliest_at: string | null;
  target_gdd: number;
  target_gdd_source: TargetGddSource;
  base_temp_c: number;
  base_temp_source: BaseTempSource;
  range_ratio: number;
  actual_from: string; // 実績の初日（出蕾日の翌日）
  actual_to: string; // 実績の最終日（昨日）。actual_from より前なら実績なし
  actual_gdd: number; // 実績の積算（気温のあった日だけ。小数 2 桁）
  actual_days: number; // 実績の期間で気温のあった日数
  actual_missing_days: number; // 実績の期間で気温が欠け、平年値で補った日数
  normals_version: string | null;
  normals_filled_days: number; // 予測に使った日のうち、平年値の欠けを前後から補った日数
  damage: "severe" | null;
  damage_events: { target_type: DamageRef["targetType"]; event_id: string; date: string }[];
  unavailable_reason?: UnavailableReason;
  unavailable_date?: string; // normals_gap のとき、平年値が使えなかった最初の日
};

export type UnavailableReason = "no_normals" | "normals_gap" | "never_reaches";

export type HarvestPrediction =
  | { kind: "skipped"; reason: "not_flowered" | "lost" }
  | {
      kind: "ok";
      valueDate: string;
      lowerDate: string;
      upperDate: string;
      needsReview: boolean;
      inputs: HarvestInputs;
    }
  | { kind: "unavailable"; reason: UnavailableReason; needsReview: boolean; inputs: HarvestInputs };

export type HarvestInput = {
  stemStatus: string;
  stemStartedAt: string;
  budDate: string | null;
  earliestAt: string | null;
  today: string; // 日本時間の今日
  daily: readonly DailyTemp[]; // 実績の期間の日平均
  hourly?: readonly HourlyDay[]; // 実績の期間の時間別
  normals: Normals;
  fieldBaseTempC: number | null;
  cultivarBaseTempC: number | null;
  fieldTargetGdd: number | null;
  cultivarTargetGdd: number | null;
  damages: readonly DamageRef[];
};

const round2 = (v: number) => Math.round(v * 100) / 100;

export function predictHarvest(input: HarvestInput): HarvestPrediction {
  if (input.stemStatus === "lost") return { kind: "skipped", reason: "lost" };
  if (input.stemStatus !== "flowered" || !input.budDate) return { kind: "skipped", reason: "not_flowered" };

  const budDate = input.budDate;
  const base = resolveBaseTemp({ fieldOverride: input.fieldBaseTempC, cultivarDefault: input.cultivarBaseTempC });
  const target = resolveTargetGdd({ fieldOverride: input.fieldTargetGdd, cultivarDefault: input.cultivarTargetGdd });
  const review = reviewDamages(input.damages, input.stemStartedAt);
  const needsReview = review.length > 0;
  const filledNormals = fillNormalsGaps(input.normals);
  const hasNormals = input.normals.version !== null && [...input.normals.byMonthDay.values()].some((v) => v !== null);

  const actualFrom = addDays(budDate, 1);
  const actualTo = addDays(input.today, -1);
  const dailyByDate = new Map(input.daily.map((d) => [d.date, d.tMean]));
  const hourlyByDate = new Map((input.hourly ?? []).map((h) => [h.date, h.temps]));

  // 実績の積算（表示・inputs 用）
  let actualGdd = 0;
  let actualDays = 0;
  let actualMissing = 0;
  const actualByDate = new Map<string, number>();
  for (const date of eachDate(actualFrom, actualTo)) {
    const g = dailyGdd({ tMean: dailyByDate.get(date) ?? null, hourlyTemps: hourlyByDate.get(date) ?? null }, base.value);
    if (g) {
      actualGdd += g.gdd;
      actualDays++;
      actualByDate.set(date, g.gdd);
    } else {
      actualMissing++;
    }
  }

  const inputs: HarvestInputs = {
    bud_date: budDate,
    earliest_at: input.earliestAt,
    target_gdd: target.value,
    target_gdd_source: target.source,
    base_temp_c: base.value,
    base_temp_source: base.source,
    range_ratio: HARVEST_RANGE_RATIO,
    actual_from: actualFrom,
    actual_to: actualTo,
    actual_gdd: round2(actualGdd),
    actual_days: actualDays,
    actual_missing_days: actualMissing,
    normals_version: normalsVersionLabel(input.normals.version),
    normals_filled_days: 0,
    damage: needsReview ? "severe" : null,
    damage_events: review.map((d) => ({ target_type: d.targetType, event_id: d.eventId, date: d.date })),
  };
  const unavailable = (reason: UnavailableReason, date?: string): HarvestPrediction => ({
    kind: "unavailable",
    reason,
    needsReview,
    inputs: { ...inputs, unavailable_reason: reason, ...(date ? { unavailable_date: date } : {}) },
  });

  // 実績の欠けた日を補うにも、先を数えるにも平年値が要る（実績だけで目標を超えていれば不要）
  const thresholds = [target.value * (1 - HARVEST_RANGE_RATIO), target.value, target.value * (1 + HARVEST_RANGE_RATIO)];
  const reached: (string | null)[] = [null, null, null];
  const filledUsed = new Set<string>();
  let cumulative = 0;
  let date = budDate;
  for (let day = 1; day <= PROJECTION_MAX_DAYS; day++) {
    date = addDays(budDate, day);
    let g = date <= actualTo ? actualByDate.get(date) : undefined;
    if (g === undefined) {
      if (!hasNormals) return unavailable("no_normals");
      const md = date.slice(5, 10);
      const normal = filledNormals.byMonthDay.get(md) ?? null;
      if (normal === null) return unavailable("normals_gap", date);
      if (filledNormals.filled.has(md)) filledUsed.add(date);
      g = Math.max(0, normal - base.value);
    }
    cumulative += g;
    for (let k = 0; k < thresholds.length; k++) {
      if (reached[k] === null && cumulative >= thresholds[k] - 1e-9) reached[k] = date;
    }
    if (reached[2] !== null) break;
  }
  inputs.normals_filled_days = filledUsed.size;
  if (reached[0] === null || reached[1] === null || reached[2] === null) return unavailable("never_reaches");
  return { kind: "ok", valueDate: reached[1], lowerDate: reached[0], upperDate: reached[2], needsReview, inputs };
}

// ---------------------------------------------------------------------------
// 推定の行と、前回との比較

export type HarvestEstimateRow = {
  stem_id: string;
  kind: "harvest_date";
  value_date: string | null;
  lower_date: string | null;
  upper_date: string | null;
  model_version: string;
  inputs: HarvestInputs;
};

export function harvestEstimateRow(stemId: string, p: Exclude<HarvestPrediction, { kind: "skipped" }>): HarvestEstimateRow {
  return {
    stem_id: stemId,
    kind: "harvest_date",
    value_date: p.kind === "ok" ? p.valueDate : null,
    lower_date: p.kind === "ok" ? p.lowerDate : null,
    upper_date: p.kind === "ok" ? p.upperDate : null,
    model_version: HARVEST_MODEL_VERSION,
    inputs: p.inputs,
  };
}

// キーの順に依らない JSON（jsonb は読み出すとキーの順が変わる）
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(",")}}`;
  }
  if (typeof v === "number") return JSON.stringify(round2(v));
  return JSON.stringify(v ?? null);
}

// 推定の中身（日付・版・入力）の署名。前回の推定と同じなら追記しない（再計算が重なっても行を増やさない）
export function estimateSignature(e: {
  value_date: string | null;
  lower_date: string | null;
  upper_date: string | null;
  model_version: string;
  inputs: unknown;
}): string {
  return stableStringify({
    value_date: e.value_date,
    lower_date: e.lower_date,
    upper_date: e.upper_date,
    model_version: e.model_version,
    inputs: e.inputs,
  });
}

// ---------------------------------------------------------------------------
// 表示

export type HarvestDisplay =
  | { state: "ok"; valueDate: string; lowerDate: string; upperDate: string; needsReview: boolean; computedAt: string }
  | { state: "unavailable"; reason: UnavailableReason; date: string | null; needsReview: boolean; computedAt: string };

// estimates の行（最新）から表示用の値。harvest_date 以外・読めない行は null
export function harvestDisplayFrom(row: {
  value_date: string | null;
  lower_date: string | null;
  upper_date: string | null;
  inputs: unknown;
  computed_at: string;
} | null): HarvestDisplay | null {
  if (!row) return null;
  const inputs = (row.inputs ?? {}) as Partial<HarvestInputs>;
  const needsReview = inputs.damage === "severe";
  if (row.value_date && row.lower_date && row.upper_date) {
    return {
      state: "ok",
      valueDate: row.value_date,
      lowerDate: row.lower_date,
      upperDate: row.upper_date,
      needsReview,
      computedAt: row.computed_at,
    };
  }
  const reason = inputs.unavailable_reason;
  if (reason !== "no_normals" && reason !== "normals_gap" && reason !== "never_reaches") return null;
  return { state: "unavailable", reason, date: inputs.unavailable_date ?? null, needsReview, computedAt: row.computed_at };
}

// "2026-11-05" → "11月5日"
export function formatMonthDay(date: string): string {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

// 幅の表示: 同じ月なら日だけ（"11月1日〜12日"）、月をまたぐなら月も（"10月28日〜11月8日"）
export function formatRange(lower: string, upper: string): string {
  const upperText = lower.slice(0, 7) === upper.slice(0, 7) ? `${Number(upper.slice(8, 10))}日` : formatMonthDay(upper);
  return `${formatMonthDay(lower)}〜${upperText}`;
}

// 「収穫予測: 11月5日ごろ（11月1日〜12日）」
export function harvestSummary(d: { valueDate: string; lowerDate: string; upperDate: string }): string {
  return `収穫予測: ${formatMonthDay(d.valueDate)}ごろ（${formatRange(d.lowerDate, d.upperDate)}）`;
}

export function unavailableMessage(reason: UnavailableReason, date: string | null): string {
  switch (reason) {
    case "no_normals":
      return "平年値の材料（過去の気温）がまだ取り込まれていないため、収穫予測を出せません";
    case "normals_gap":
      return `${date ? `${formatMonthDay(date)}ごろの` : ""}平年値が足りない（過去の気温が 3 年分そろっていない）ため、収穫予測を出せません`;
    case "never_reaches":
      return `出蕾から ${PROJECTION_MAX_DAYS} 日以内に目標の積算温度に達しないため、収穫予測を出せません`;
  }
}
