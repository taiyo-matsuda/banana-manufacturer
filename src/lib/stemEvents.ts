// 茎のイベント記録（1-8）の純粋ロジック。UI・DB に依存しない。
//
// - どの状態でどのイベントを記録できるか、イベントで状態がどう変わるかの表は
//   DB の RPC `record_stem_event`（supabase/migrations/0008_record_stem_event.sql）と同じ表。片方を変えたら両方を変える。
//   DB が正本で、ここは UI の出し分け（ボタン）と Server Action の事前判定に使う
// - 出蕾の累計葉数は Server Action が leaves.ts の cumulativeLeaves で計算して payload に入れる
// - 入力の解釈（parse*）はここに置き、Server Action は FormData を文字列にして渡すだけにする
// - 吸芽の採用・芽かき・株分け（2-2）の状態の前提もここに置く（0011_sucker_actions.sql と同じ表）
import { isValidDateString } from "./mats/placement";
import { parseInitialLeafCount } from "./stems/leaf-count";
import { canAddActiveStem, MAX_ACTIVE_STEMS } from "./stems/registration";
import { stemStatusLabel } from "./stems/status";

// この画面（茎の記録入力）から記録できるイベント
export const STEM_EVENT_TYPES = ["bud_emerged", "hands_counted", "bagged", "debudded", "harvested", "damage"] as const;
export type StemEventType = (typeof STEM_EVENT_TYPES)[number];

export const STEM_EVENT_LABELS: Record<StemEventType, string> = {
  bud_emerged: "出蕾",
  hands_counted: "段数",
  bagged: "袋掛け",
  debudded: "摘蕾",
  harvested: "収穫",
  damage: "被害",
};

export function isStemEventType(s: string): s is StemEventType {
  return (STEM_EVENT_TYPES as readonly string[]).includes(s);
}

export function stemEventLabel(type: string): string {
  return (STEM_EVENT_LABELS as Record<string, string>)[type] ?? type;
}

// --- 被害の種類・程度（要件 4.3） ----------------------------------------------------

export const DAMAGE_KINDS = ["lodging", "leaf_tear", "break", "cold", "disease"] as const;
export type DamageKind = (typeof DAMAGE_KINDS)[number];
export const DAMAGE_KIND_LABELS: Record<DamageKind, string> = {
  lodging: "倒伏",
  leaf_tear: "裂葉",
  break: "折損",
  cold: "寒害",
  disease: "病害",
};

export const DAMAGE_SEVERITIES = ["light", "moderate", "severe", "lost"] as const;
export type DamageSeverity = (typeof DAMAGE_SEVERITIES)[number];
export const DAMAGE_SEVERITY_LABELS: Record<DamageSeverity, string> = {
  light: "軽",
  moderate: "中",
  severe: "重",
  lost: "喪失",
};

export const isDamageKind = (s: string): s is DamageKind => (DAMAGE_KINDS as readonly string[]).includes(s);
export const isDamageSeverity = (s: string): s is DamageSeverity =>
  (DAMAGE_SEVERITIES as readonly string[]).includes(s);

export function damageKindLabel(kind: unknown): string {
  return typeof kind === "string" ? ((DAMAGE_KIND_LABELS as Record<string, string>)[kind] ?? kind) : "";
}
export function damageSeverityLabel(severity: unknown): string {
  return typeof severity === "string" ? ((DAMAGE_SEVERITY_LABELS as Record<string, string>)[severity] ?? severity) : "";
}

// --- 状態遷移の表（0008_record_stem_event.sql と同じ表） ------------------------------

// どの状態でどのイベントを記録できるか
const ALLOWED_STATUSES: Record<StemEventType, readonly string[]> = {
  bud_emerged: ["active"],
  hands_counted: ["flowered"],
  bagged: ["flowered"],
  debudded: ["flowered"],
  harvested: ["flowered"],
  damage: ["active", "flowered"],
};

export function canRecordEvent(status: string, type: string): boolean {
  if (!isStemEventType(type)) return false;
  return ALLOWED_STATUSES[type].includes(status);
}

// ボタンに出すイベント（表示順）。active → 出蕾・被害 / flowered → 段数・袋掛け・摘蕾・収穫・被害 / それ以外 → なし
export function allowedEventTypes(status: string): StemEventType[] {
  return STEM_EVENT_TYPES.filter((t) => canRecordEvent(status, t));
}

// イベントを記録した後の状態。記録できない組み合わせは null。吸芽の採用・芽かき・株分け（2-2）も扱う
export function nextStatus(status: string, type: string, payload: Record<string, unknown> = {}): string | null {
  if (isSuckerActionType(type)) return suckerActionNextStatus(status, type);
  if (!canRecordEvent(status, type)) return null;
  switch (type) {
    case "bud_emerged":
      return "flowered";
    case "harvested":
      return "harvested";
    case "damage":
      return payload.severity === "lost" ? "lost" : status;
    default:
      return status; // hands_counted / bagged / debudded
  }
}

// --- 吸芽の採用・芽かき・株分け（2-2） ------------------------------------------------
//
// 3 つとも吸芽（status=sucker）の茎にだけできる。DB の RPC（supabase/migrations/0011_sucker_actions.sql の
// adopt_sucker / remove_sucker / transplant_sucker。前提の確認は lock_sucker_stem）と同じ表。片方を変えたら両方を変える。
// DB が正本で、ここは株の詳細のボタンの出し分けと、オフラインで積んだ分の見かけの状態（overlay）に使う。
// 採用の「栽培中は最大 3 本」の正本は 0001 のトリガー stems_max_active（canAdoptSucker は事前の判定）。

export const SUCKER_ACTION_TYPES = ["sucker_adopted", "sucker_removed", "sucker_transplanted"] as const;
export type SuckerActionType = (typeof SUCKER_ACTION_TYPES)[number];

export const SUCKER_ACTION_LABELS: Record<SuckerActionType, string> = {
  sucker_adopted: "採用",
  sucker_removed: "芽かき",
  sucker_transplanted: "株分け",
};

const SUCKER_ACTION_NEXT_STATUS: Record<SuckerActionType, string> = {
  sucker_adopted: "active",
  sucker_removed: "removed",
  sucker_transplanted: "transplanted",
};

export function isSuckerActionType(s: string): s is SuckerActionType {
  return (SUCKER_ACTION_TYPES as readonly string[]).includes(s);
}

export function canDoSuckerAction(status: string, action: string): boolean {
  return isSuckerActionType(action) && status === "sucker";
}

// 操作した後の茎の状態。できない組み合わせは null
export function suckerActionNextStatus(status: string, action: string): string | null {
  if (!isSuckerActionType(action) || !canDoSuckerAction(status, action)) return null;
  return SUCKER_ACTION_NEXT_STATUS[action];
}

// できない理由（RPC の lock_sucker_stem の例外と同じ文言）。できるなら null
export function suckerActionError(status: string, action: SuckerActionType): string | null {
  if (canDoSuckerAction(status, action)) return null;
  return `${SUCKER_ACTION_LABELS[action]}は吸芽の茎にだけできます（この茎は${stemStatusLabel(status)}）`;
}

// 採用で栽培中が 3 本を超えるときの理由（RPC adopt_sucker がトリガーの例外を言い換える文言と同じ）
export const ADOPT_MAX_ACTIVE_MESSAGE = `この株には栽培中の茎が ${MAX_ACTIVE_STEMS} 本あるため採用できません。先に他の吸芽を芽かきするか株分けしてください`;

export type SuckerActionCheck = { ok: true } | { ok: false; reason: string };

// 採用できるか（吸芽であること＋株の栽培中が 3 本未満であること）。matStems は同じ株の茎（見かけの状態）
export function canAdoptSucker(stem: { status: string }, matStems: readonly { status: string }[]): SuckerActionCheck {
  const err = suckerActionError(stem.status, "sucker_adopted");
  if (err) return { ok: false, reason: err };
  if (!canAddActiveStem(matStems).ok) return { ok: false, reason: ADOPT_MAX_ACTIVE_MESSAGE };
  return { ok: true };
}

// 採用・株分けの初期葉数（必須。0 以上の整数）
export function parseRequiredInitialLeafCount(input: string | null | undefined): EventParse<number> {
  const parsed = parseInitialLeafCount(input);
  if (!parsed.ok) return parsed;
  if (parsed.value === null) return { ok: false, error: "初期葉数を入力してください" };
  return { ok: true, value: parsed.value };
}

// --- 日付 ------------------------------------------------------------------------

// 日本時間の日付（YYYY-MM-DD）
const jstDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
export function todayJst(now: Date = new Date()): string {
  return jstDate.format(now);
}

// 画面で入れた日付（YYYY-MM-DD）を occurred_at（timestamptz、ISO 文字列）にする。
// 今日なら今の時刻（同じ日の観測より後に並ぶ）、過去日なら その日の 0:00 JST
export function occurredAtFromDate(date: string, now: Date = new Date()): string {
  if (date === todayJst(now)) return now.toISOString();
  return new Date(`${date}T00:00:00+09:00`).toISOString();
}

// 直近の日時を日本時間の日付にする（出蕾の「前回訪問日」の既定値）。なければ null
export function latestDateJst(dates: readonly (Date | string)[]): string | null {
  let latest: Date | null = null;
  for (const d of dates) {
    const t = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(t.getTime())) continue;
    if (!latest || t.getTime() > latest.getTime()) latest = t;
  }
  return latest ? todayJst(latest) : null;
}

// --- 入力の解釈 ------------------------------------------------------------------

export type EventParse<T> = { ok: true; value: T } | { ok: false; error: string };

export type EventFormInput = {
  type: string;
  date: string; // 確認日 YYYY-MM-DD
  earliestAt?: string; // 出蕾: 前回訪問日（任意）
  leavesCurrent?: string; // 出蕾: 生葉数
  girthCm?: string; // 出蕾: 偽茎周囲長 cm
  hands?: string; // 段数
  weightKg?: string; // 収穫: 果房重量 kg（小数 1 桁）
  kind?: string; // 被害: 種類
  severity?: string; // 被害: 程度
};

// 解釈済みの入力。payload は cumulative_leaves（Server Action が足す）を除いた events.payload
export type ParsedEvent = {
  type: StemEventType;
  date: string;
  payload: Record<string, unknown>;
};

function parseIntMin(input: string | undefined, label: string, min: number): EventParse<number> {
  const s = (input ?? "").trim();
  if (s === "") return { ok: false, error: `${label}を入力してください` };
  if (!/^\d+$/.test(s)) return { ok: false, error: `${label}は ${min} 以上の整数で入力してください` };
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min) return { ok: false, error: `${label}は ${min} 以上の整数で入力してください` };
  return { ok: true, value: n };
}

function parsePositiveNumber(input: string | undefined, label: string, maxDecimals: number): EventParse<number> {
  const s = (input ?? "").trim();
  if (s === "") return { ok: false, error: `${label}を入力してください` };
  const pattern = maxDecimals > 0 ? new RegExp(`^\\d+(\\.\\d{1,${maxDecimals}})?$`) : /^\d+$/;
  const hint = maxDecimals > 0 ? `${label}は 0 より大きい数（小数 ${maxDecimals} 桁まで）で入力してください` : `${label}は 0 より大きい数で入力してください`;
  if (!pattern.test(s)) return { ok: false, error: hint };
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: hint };
  return { ok: true, value: n };
}

export function parseEventInput(input: EventFormInput): EventParse<ParsedEvent> {
  if (!isStemEventType(input.type)) return { ok: false, error: "記録するイベントを選んでください" };
  const type = input.type;
  const date = (input.date ?? "").trim();
  if (!isValidDateString(date)) return { ok: false, error: "日付を YYYY-MM-DD で入力してください" };

  switch (type) {
    case "bud_emerged": {
      const earliest = (input.earliestAt ?? "").trim();
      if (earliest !== "" && !isValidDateString(earliest)) {
        return { ok: false, error: "前回訪問日を YYYY-MM-DD で入力してください（空でもよい）" };
      }
      if (earliest !== "" && earliest > date) {
        return { ok: false, error: "前回訪問日は確認日より前の日付にしてください" };
      }
      const leaves = parseIntMin(input.leavesCurrent, "生葉数", 0);
      if (!leaves.ok) return leaves;
      const girth = parsePositiveNumber(input.girthCm, "偽茎周囲長", 1);
      if (!girth.ok) return girth;
      return {
        ok: true,
        value: {
          type,
          date,
          payload: { leaves_current: leaves.value, girth_cm: girth.value, earliest_at: earliest === "" ? null : earliest },
        },
      };
    }
    case "hands_counted": {
      const hands = parseIntMin(input.hands, "段数", 1);
      if (!hands.ok) return hands;
      return { ok: true, value: { type, date, payload: { hands: hands.value } } };
    }
    case "harvested": {
      const weight = parsePositiveNumber(input.weightKg, "果房重量", 1);
      if (!weight.ok) return weight;
      return { ok: true, value: { type, date, payload: { weight_kg: weight.value } } };
    }
    case "damage": {
      const kind = (input.kind ?? "").trim();
      if (!isDamageKind(kind)) return { ok: false, error: "被害の種類を選んでください" };
      const severity = (input.severity ?? "").trim();
      if (!isDamageSeverity(severity)) return { ok: false, error: "被害の程度を選んでください" };
      return { ok: true, value: { type, date, payload: { kind, severity } } };
    }
    case "bagged":
    case "debudded":
      return { ok: true, value: { type, date, payload: {} } };
  }
}

// --- 履歴の表示（payload の要点） -----------------------------------------------------

export function stemEventValueText(type: string, payload: Record<string, unknown> | null | undefined): string {
  const p = payload ?? {};
  switch (type) {
    case "bud_emerged": {
      const parts: string[] = [];
      if (typeof p.cumulative_leaves === "number") parts.push(`累計葉数 ${p.cumulative_leaves} 枚`);
      if (typeof p.leaves_current === "number") parts.push(`生葉数 ${p.leaves_current} 枚`);
      if (typeof p.girth_cm === "number") parts.push(`周囲長 ${p.girth_cm} cm`);
      return parts.join("・");
    }
    case "hands_counted":
      return typeof p.hands === "number" ? `${p.hands} 段` : "";
    case "harvested":
      return typeof p.weight_kg === "number" ? `${p.weight_kg} kg` : "";
    case "damage":
      return [damageKindLabel(p.kind), damageSeverityLabel(p.severity)].filter((s) => s !== "").join("・");
    case "bagged":
    case "debudded":
      return "";
    default:
      return "";
  }
}

// 記録 Server Action の戻り値（useActionState の state）
export type EventRecordState = {
  error: string | null;
  succeeded: number;
  lastType: StemEventType | null; // 直前に記録したイベント（「出蕾を記録しました」の表示用）
};

export const INITIAL_EVENT_RECORD_STATE: EventRecordState = { error: null, succeeded: 0, lastType: null };
