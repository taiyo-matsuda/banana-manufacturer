// 茎の記録入力（1-6）の純粋ロジック。UI・DB に依存しない。
//
// - 記録できるのは栽培中（active / flowered）の茎だけ。それ以外は履歴へのリンクだけを出す
// - leaves_new / leaves_current は observations、leaves_removed（枯葉処理）は events に追記する
// - 観測・イベントは追記のみ。編集・削除はしない（訂正はステップ 2 で superseded_by による新レコードの追加）
// - 履歴は観測とイベントを 1 つの時系列に混ぜ、新しい順に並べる
import type { LeafObservation, LeavesRemovedEvent } from "../leaves";

// 記録ボタンを出す状態（茎の記録入力画面）
export const RECORDABLE_STEM_STATUSES = ["active", "flowered"] as const;

export function canRecordLeaves(status: string): boolean {
  return (RECORDABLE_STEM_STATUSES as readonly string[]).includes(status);
}

// --- 入力（枚数）の解釈 ---------------------------------------------------------

export type CountParse = { ok: true; value: number } | { ok: false; error: string };

// 0 以上（または min 以上）の整数にする。空・小数・負数は理由付きで拒否
export function parseCount(input: string | null | undefined, label: string, min = 0): CountParse {
  const s = (input ?? "").trim();
  if (s === "") return { ok: false, error: `${label}を入力してください` };
  if (!/^\d+$/.test(s)) return { ok: false, error: `${label}は ${min} 以上の整数で入力してください` };
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min) {
    return { ok: false, error: `${label}は ${min} 以上の整数で入力してください` };
  }
  return { ok: true, value: n };
}

export const parseLeavesNew = (input: string | null | undefined) => parseCount(input, "新たに開いた葉の枚数", 0);
export const parseLeavesCurrent = (input: string | null | undefined) => parseCount(input, "現在の葉数", 0);
export const parseLeavesRemoved = (input: string | null | undefined) => parseCount(input, "除去した枚数", 1);

// --- 文言 -------------------------------------------------------------------

export const OBSERVATION_LABELS: Record<string, string> = {
  leaves_new: "新葉",
  leaves_current: "現在の葉数",
  pseudostem_girth_cm: "偽茎周囲長",
  height_cm: "高さ",
};

export const EVENT_LABELS: Record<string, string> = {
  bud_emerged: "出蕾",
  hands_counted: "段数",
  bagged: "袋掛け",
  debudded: "摘蕾",
  harvested: "収穫",
  leaves_removed: "枯葉処理",
  fertilized: "施肥",
  damage: "被害",
  sucker_emerged: "吸芽の発生",
  sucker_adopted: "吸芽の採用",
  sucker_removed: "芽かき",
  sucker_transplanted: "株分け",
  stem_removed: "茎の除去",
  mat_removed: "株の除去",
};

export function observationLabel(type: string): string {
  return OBSERVATION_LABELS[type] ?? type;
}

export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type;
}

// 観測の値の表示。leaves_new は「+1」のように増分として見せる
export function observationValueText(type: string, value: number): string {
  switch (type) {
    case "leaves_new":
      return `+${value}`;
    case "leaves_current":
      return `${value} 枚`;
    case "pseudostem_girth_cm":
    case "height_cm":
      return `${value} cm`;
    default:
      return String(value);
  }
}

// イベントの payload の表示。既知のものは日本語、それ以外は key=value で並べる
export function eventValueText(type: string, payload: Record<string, unknown> | null | undefined): string {
  const p = payload ?? {};
  switch (type) {
    case "leaves_removed":
      return typeof p.count === "number" ? `${p.count} 枚` : "";
    case "hands_counted":
      return typeof p.hands === "number" ? `${p.hands} 段` : "";
    case "harvested":
      return typeof p.weight_kg === "number" ? `${p.weight_kg} kg` : "";
    case "bagged":
    case "debudded":
      return "";
    default:
      return Object.entries(p)
        .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
        .join(" ");
  }
}

// --- 履歴 -------------------------------------------------------------------

export type ObservationRow = {
  id: string;
  type: string;
  value: number;
  observed_at: string;
  superseded_by: string | null;
  observer_name?: string | null;
};

export type EventRow = {
  id: string;
  type: string;
  occurred_at: string;
  payload: Record<string, unknown> | null;
  superseded_by: string | null;
  recorder_name?: string | null;
};

export type HistoryEntry = {
  key: string; // "observation:<id>" / "event:<id>"
  kind: "observation" | "event";
  type: string;
  label: string;
  valueText: string;
  at: Date;
  by: string | null;
  superseded: boolean; // 訂正済み（打ち消し表示）
};

// 観測とイベントを 1 つの時系列にして新しい順（同時刻は観測 → イベント、さらに同じなら id 順）に並べる
export function buildHistory(observations: readonly ObservationRow[], events: readonly EventRow[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [
    ...observations.map<HistoryEntry>((o) => ({
      key: `observation:${o.id}`,
      kind: "observation",
      type: o.type,
      label: observationLabel(o.type),
      valueText: observationValueText(o.type, Number(o.value)),
      at: new Date(o.observed_at),
      by: o.observer_name ?? null,
      superseded: o.superseded_by !== null,
    })),
    ...events.map<HistoryEntry>((e) => ({
      key: `event:${e.id}`,
      kind: "event",
      type: e.type,
      label: eventLabel(e.type),
      valueText: eventValueText(e.type, e.payload),
      at: new Date(e.occurred_at),
      by: e.recorder_name ?? null,
      superseded: e.superseded_by !== null,
    })),
  ];
  return entries.sort(
    (a, b) =>
      b.at.getTime() - a.at.getTime() ||
      (a.kind === b.kind ? 0 : a.kind === "observation" ? -1 : 1) ||
      a.key.localeCompare(b.key),
  );
}

// --- 累計・検算の入力に変換 ---------------------------------------------------

// 現在の値（superseded_by が null）の葉の観測だけを leaves.ts の入力にする
export function toLeafObservations(observations: readonly ObservationRow[]): LeafObservation[] {
  return observations
    .filter((o) => o.superseded_by === null && (o.type === "leaves_new" || o.type === "leaves_current"))
    .map((o) => ({
      type: o.type as LeafObservation["type"],
      value: Number(o.value),
      observedAt: new Date(o.observed_at),
    }));
}

// 現在の値の枯葉処理イベントだけを leaves.ts の入力にする（count が数値でないものは数えない）
export function toLeavesRemoved(events: readonly EventRow[]): LeavesRemovedEvent[] {
  return events
    .filter((e) => e.superseded_by === null && e.type === "leaves_removed")
    .map((e) => ({ count: Number(e.payload?.count ?? 0), occurredAt: new Date(e.occurred_at) }))
    .filter((r) => Number.isFinite(r.count));
}

// 日時の表示（日本時間、分まで）。サーバーのタイムゾーンに依存しない
const dateTimeFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatDateTime(at: Date): string {
  return dateTimeFormat.format(at);
}

// 記録 Server Action の戻り値（useActionState の state）
export type RecordState = {
  error: string | null;
  succeeded: number;
};

export const INITIAL_RECORD_STATE: RecordState = { error: null, succeeded: 0 };
