// 記録の訂正（2-6、要件 5.5、data-model 2.2）の純粋ロジック。UI・DB に依存しない。
//
// - 訂正は「新しい行を追加し、元の行の superseded_by に新しい行の id を入れる」。DB の RPC
//   correct_observation / correct_stem_event（supabase/migrations/0014_corrections.sql）が正本で、
//   訂正できる種類・項目の表はここと同じ。片方を変えたら両方を変える
// - 訂正できるのは茎の観測（4 種類）と茎のイベント（7 種類）の日付と payload の数値だけ。イベントの種類は変えられない
// - 被害の「喪失」は茎の状態を変えたイベントなので、喪失のまま（日付・種類）か、喪失以外の中での変更だけ
// - オンライン前提（outbox に積まない）。未同期の行（outbox にある）は同期してから
// - 出蕾の payload の cumulative_leaves は出蕾時点の記録（スナップショット）として残す（訂正で直さない）
import { isValidDateString } from "./mats/placement";
import { parseCount } from "./stems/records";
import type { EventRow, ObservationRow } from "./stems/records";
import {
  type DamageSeverity,
  type EventParse,
  isDamageSeverity,
  occurredAtFromDate,
  parseEventInput,
  todayJst,
} from "./stemEvents";

export const CORRECTABLE_OBSERVATION_TYPES = ["leaves_new", "leaves_current", "pseudostem_girth_cm", "height_cm"] as const;
export type CorrectableObservationType = (typeof CORRECTABLE_OBSERVATION_TYPES)[number];

export const CORRECTABLE_EVENT_TYPES = [
  "bud_emerged",
  "hands_counted",
  "bagged",
  "debudded",
  "harvested",
  "leaves_removed",
  "damage",
] as const;
export type CorrectableEventType = (typeof CORRECTABLE_EVENT_TYPES)[number];

export type RecordKind = "observation" | "event" | "photo";

export function isCorrectableObservationType(type: string): type is CorrectableObservationType {
  return (CORRECTABLE_OBSERVATION_TYPES as readonly string[]).includes(type);
}

export function isCorrectableEventType(type: string): type is CorrectableEventType {
  return (CORRECTABLE_EVENT_TYPES as readonly string[]).includes(type);
}

// その種類の行に「訂正」を出すか（写真・吸芽系・施肥などは出さない）
export function isCorrectableType(kind: RecordKind, type: string): boolean {
  if (kind === "observation") return isCorrectableObservationType(type);
  if (kind === "event") return isCorrectableEventType(type);
  return false;
}

// --- 訂正できるか（ボタンの可否と理由） ---------------------------------------------

export const ALREADY_CORRECTED_MESSAGE = "この記録はすでに訂正されています。最新の記録を訂正してください";
export const PENDING_CORRECTION_MESSAGE = "同期してから訂正してください";
export const OFFLINE_CORRECTION_MESSAGE = "訂正は電波のあるところで行ってください（端末に貯めません）";

export type CorrectionTarget = {
  targetType: "stem" | "field" | "mat"; // どの画面の履歴か。訂正できるのは茎の観測・イベントだけ（圃場・株の記録は 2-6 の対象外）
  kind: RecordKind;
  type: string;
  superseded: boolean;
  pending: boolean;
};

export type CorrectionAvailability =
  | { show: false }
  | { show: true; enabled: true }
  | { show: true; enabled: false; reason: string };

// 訂正ボタンを出すか・押せるか。茎以外（圃場・株の記録）、訂正済みの行（打ち消し表示）、対象外の種類にはボタンを出さない
export function correctionAvailability(target: CorrectionTarget, online: boolean): CorrectionAvailability {
  if (target.targetType !== "stem") return { show: false };
  if (!isCorrectableType(target.kind, target.type) || target.superseded) return { show: false };
  if (target.pending) return { show: true, enabled: false, reason: PENDING_CORRECTION_MESSAGE };
  if (!online) return { show: true, enabled: false, reason: OFFLINE_CORRECTION_MESSAGE };
  return { show: true, enabled: true };
}

// --- 入力（ダイアログのフォーム） -------------------------------------------------------

// ダイアログの入力（すべて文字列で持つ。エラーで戻っても入力が残るよう React の state にする）
export type CorrectionForm = {
  date: string; // YYYY-MM-DD（日本時間）
  value: string; // 観測の値
  leavesCurrent: string; // 出蕾: 生葉数
  girthCm: string; // 出蕾: 偽茎周囲長
  earliestAt: string; // 出蕾: 前回訪問日（空でもよい）
  hands: string; // 段数
  weightKg: string; // 収穫: 果房重量
  count: string; // 枯葉処理: 除去した枚数
  kind: string; // 被害: 種類
  severity: string; // 被害: 程度
};

export type CorrectionOriginal = {
  kind: "observation" | "event";
  type: string;
  at: string; // observed_at / occurred_at（ISO）
  value?: number; // 観測の値
  payload?: Record<string, unknown> | null; // イベントの payload
};

const str = (v: unknown): string => (typeof v === "number" || typeof v === "string" ? String(v) : "");

// 元の値を初期値にしたフォーム
export function initialCorrectionForm(original: CorrectionOriginal): CorrectionForm {
  const p = original.payload ?? {};
  return {
    date: todayJst(new Date(original.at)),
    value: original.value === undefined ? "" : String(original.value),
    leavesCurrent: str(p.leaves_current),
    girthCm: str(p.girth_cm),
    earliestAt: str(p.earliest_at),
    hands: str(p.hands),
    weightKg: str(p.weight_kg),
    count: str(p.count),
    kind: str(p.kind),
    severity: str(p.severity),
  };
}

export const NO_CHANGE_MESSAGE = "元の記録と同じです。直す項目を変えてください";
export const FUTURE_DATE_MESSAGE = "未来の日付には訂正できません";
export const LOST_SEVERITY_LOCKED_MESSAGE = "「喪失」の被害は程度を変えられません（日付と種類だけ訂正できます）";
export const LOST_SEVERITY_FORBIDDEN_MESSAGE = "訂正で「喪失」にはできません（茎の状態は変えられません）";

function parseDate(date: string, now: Date): EventParse<string> {
  const d = date.trim();
  if (!isValidDateString(d)) return { ok: false, error: "日付を YYYY-MM-DD で入力してください" };
  if (d > todayJst(now)) return { ok: false, error: FUTURE_DATE_MESSAGE };
  return { ok: true, value: d };
}

function parseObservationValue(type: CorrectableObservationType, input: string): EventParse<number> {
  switch (type) {
    case "leaves_new":
      return parseCount(input, "新たに開いた葉の枚数", 0);
    case "leaves_current":
      return parseCount(input, "現在の葉数", 0);
    case "pseudostem_girth_cm":
    case "height_cm": {
      const label = type === "height_cm" ? "高さ" : "偽茎周囲長";
      const s = input.trim();
      const hint = `${label}は 0 より大きい数（小数 1 桁まで）で入力してください`;
      if (s === "") return { ok: false, error: `${label}を入力してください` };
      if (!/^\d+(\.\d)?$/.test(s)) return { ok: false, error: hint };
      const n = Number(s);
      if (!(n > 0)) return { ok: false, error: hint };
      return { ok: true, value: n };
    }
  }
}

export type ObservationCorrection = { date: string; value: number };

// 観測の訂正の入力を解釈する。元と同じなら拒否
export function parseObservationCorrection(
  original: CorrectionOriginal,
  form: CorrectionForm,
  now: Date = new Date(),
): EventParse<ObservationCorrection> {
  if (!isCorrectableObservationType(original.type)) return { ok: false, error: "この記録は訂正できません" };
  const date = parseDate(form.date, now);
  if (!date.ok) return date;
  const value = parseObservationValue(original.type, form.value);
  if (!value.ok) return value;
  if (date.value === todayJst(new Date(original.at)) && value.value === Number(original.value)) {
    return { ok: false, error: NO_CHANGE_MESSAGE };
  }
  return { ok: true, value: { date: date.value, value: value.value } };
}

export type EventCorrection = { date: string; payload: Record<string, unknown> };

// 比べる payload の項目（訂正できる項目）
const EDITABLE_KEYS: Record<CorrectableEventType, readonly string[]> = {
  bud_emerged: ["leaves_current", "girth_cm", "earliest_at"],
  hands_counted: ["hands"],
  bagged: [],
  debudded: [],
  harvested: ["weight_kg"],
  leaves_removed: ["count"],
  damage: ["kind", "severity"],
};

// 被害の程度の変更が許されるか（喪失のまま、または喪失以外の中で）
export function damageSeverityChangeError(oldSeverity: unknown, newSeverity: DamageSeverity): string | null {
  const wasLost = oldSeverity === "lost";
  const isLost = newSeverity === "lost";
  if (wasLost && !isLost) return LOST_SEVERITY_LOCKED_MESSAGE;
  if (!wasLost && isLost) return LOST_SEVERITY_FORBIDDEN_MESSAGE;
  return null;
}

// 被害の訂正で選べる程度（喪失なら喪失だけ、それ以外なら喪失を除く）
export function correctableSeverities(oldSeverity: unknown): DamageSeverity[] {
  if (oldSeverity === "lost") return ["lost"];
  return ["light", "moderate", "severe"];
}

// イベントの訂正の入力を解釈する。payload は訂正できる項目だけ（RPC が元の payload に重ねる）。元と同じなら拒否
export function parseEventCorrection(
  original: CorrectionOriginal,
  form: CorrectionForm,
  now: Date = new Date(),
): EventParse<EventCorrection> {
  const type = original.type;
  if (!isCorrectableEventType(type)) return { ok: false, error: "この記録は訂正できません" };
  const date = parseDate(form.date, now);
  if (!date.ok) return date;

  let payload: Record<string, unknown>;
  if (type === "leaves_removed") {
    const count = parseCount(form.count, "除去した枚数", 1);
    if (!count.ok) return count;
    payload = { count: count.value };
  } else {
    const parsed = parseEventInput({
      type,
      date: date.value,
      earliestAt: form.earliestAt,
      leavesCurrent: form.leavesCurrent,
      girthCm: form.girthCm,
      hands: form.hands,
      weightKg: form.weightKg,
      kind: form.kind,
      severity: form.severity,
    });
    if (!parsed.ok) return parsed;
    payload = parsed.value.payload;
    if (type === "damage") {
      const severity = payload.severity;
      if (!isDamageSeverity(String(severity))) return { ok: false, error: "被害の程度を選んでください" };
      const err = damageSeverityChangeError(original.payload?.severity, severity as DamageSeverity);
      if (err) return { ok: false, error: err };
    }
  }

  const old = original.payload ?? {};
  const same =
    date.value === todayJst(new Date(original.at)) &&
    EDITABLE_KEYS[type].every((k) => (old[k] ?? null) === (payload[k] ?? null));
  if (same) return { ok: false, error: NO_CHANGE_MESSAGE };
  return { ok: true, value: { date: date.value, payload } };
}

// 新しい行の日時。日付を変えていなければ元の時刻のまま（履歴の並び・検算の前後関係を変えない）。
// 変えたら記録と同じ規則（今日なら今の時刻、過去日ならその日の 0:00 JST）
export function correctedTimestamp(date: string, originalAt: string, now: Date = new Date()): string {
  if (todayJst(new Date(originalAt)) === date) return new Date(originalAt).toISOString();
  return occurredAtFromDate(date, now);
}

// 同じ内容の再送かを見分ける鍵（内容が同じなら同じ新しい id で送る）
export function correctionKey(original: CorrectionOriginal & { id: string }, content: unknown): string {
  return JSON.stringify([original.kind, original.id, content]);
}

// --- 出蕾時の累計葉数（記録と現在の計算） ---------------------------------------------

export type BudLeafSnapshot = { recorded: number; computed: number };

// 現在の出蕾イベントの payload の cumulative_leaves（出蕾時点の記録）と、現在の観測から計算し直した出蕾時点の累計葉数
// （初期葉数 + 出蕾日（日本時間）以前の現在の leaves_new の合計）。出蕾がない・記録がないときは null
export function budLeafSnapshot(
  initialLeafCount: number,
  observations: readonly Pick<ObservationRow, "type" | "value" | "observed_at" | "superseded_by">[],
  events: readonly Pick<EventRow, "type" | "occurred_at" | "payload" | "superseded_by">[],
): BudLeafSnapshot | null {
  const bud = events.find((e) => e.type === "bud_emerged" && e.superseded_by === null);
  if (!bud) return null;
  const recorded = bud.payload?.cumulative_leaves;
  if (typeof recorded !== "number") return null;
  const budDate = todayJst(new Date(bud.occurred_at));
  const computed =
    initialLeafCount +
    observations
      .filter((o) => o.superseded_by === null && o.type === "leaves_new" && todayJst(new Date(o.observed_at)) <= budDate)
      .reduce((sum, o) => sum + Number(o.value), 0);
  return { recorded, computed };
}

// 記録と計算が食い違うときだけ表示する文言。一致すれば null
export function budLeafSnapshotText(snapshot: BudLeafSnapshot | null): string | null {
  if (!snapshot || snapshot.recorded === snapshot.computed) return null;
  return `出蕾時の累計葉数（記録）${snapshot.recorded} 枚 / 現在の計算 ${snapshot.computed} 枚`;
}
