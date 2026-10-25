// 圃場・株を対象にした被害（2-5、要件 4.3・5.4・UC-6）の純粋ロジック。UI・DB に依存しない。
//
// - 種類・程度の定義と日本語ラベルは茎の被害（1-8）と同じ（stemEvents.ts の DAMAGE_*。ここで重複させない）
// - 「喪失（lost）」は茎にだけ意味がある（茎を lost にして予測から外す）。圃場・株の被害では選べない。
//   株を失ったなら撤去（2-3）、茎を失ったなら茎の被害を使う
// - 保存は events（type=damage、target_type=field / mat、payload {kind, severity}、メモは events.note）
// - 圃場の被害から、その圃場の株に同じ内容を一括で記録できる。株ごとの damage イベント（target_type=mat）の
//   payload に圃場の被害イベントの id（field_event_id）と、確定ごとの batch_id（再送で二重にしない）を入れる
// - 画面（Client Component）と Server Action の両方で同じ検証を使う（サーバー側の検証が正本）
import { UUID_PATTERN } from "./fertilize";
import { isValidDateString } from "./mats/placement";
import {
  DAMAGE_SEVERITIES,
  type DamageKind,
  type DamageSeverity,
  isDamageKind,
  isDamageSeverity,
  todayJst,
} from "./stemEvents";

export type DamageTargetType = "field" | "mat";

// 圃場・株の被害で選べる程度（喪失を除く。表示順は茎の被害と同じ）
export type TargetDamageSeverity = Exclude<DamageSeverity, "lost">;
export const TARGET_DAMAGE_SEVERITIES = DAMAGE_SEVERITIES.filter(
  (s): s is TargetDamageSeverity => s !== "lost",
);

export function isTargetDamageSeverity(s: unknown): s is TargetDamageSeverity {
  return typeof s === "string" && isDamageSeverity(s) && s !== "lost";
}

// 程度の選択肢の近くに出す案内
export const LOST_NOT_ALLOWED_HINT =
  "「喪失」は選べません。株を失ったなら株の撤去を、茎を失ったなら茎の被害を記録してください";
// Server Action に lost が届いたとき（画面からは送られない）
export const LOST_REJECTED_MESSAGE =
  "圃場・株の被害に「喪失」は記録できません。株を失ったなら株の撤去を、茎を失ったなら茎の被害を記録してください";

export const MAX_DAMAGE_NOTE_LENGTH = 200;
export const RELOAD_MESSAGE = "画面を再読み込みしてやり直してください";

export type Parse<T> = { ok: true; value: T } | { ok: false; error: string };

// --- 入力の解釈 ------------------------------------------------------------------

// 日付: YYYY-MM-DD、未来の日付は拒否（日本時間）
export function parseDamageDate(input: string | null | undefined, now: Date = new Date()): Parse<string> {
  const s = (input ?? "").trim();
  if (!isValidDateString(s)) return { ok: false, error: "日付を YYYY-MM-DD で入力してください" };
  if (s > todayJst(now)) return { ok: false, error: "未来の日付は記録できません" };
  return { ok: true, value: s };
}

export function parseDamageKind(input: string | null | undefined): Parse<DamageKind> {
  const s = (input ?? "").trim();
  if (!isDamageKind(s)) return { ok: false, error: "被害の種類を選んでください" };
  return { ok: true, value: s };
}

export function parseTargetDamageSeverity(input: string | null | undefined): Parse<TargetDamageSeverity> {
  const s = (input ?? "").trim();
  if (s === "lost") return { ok: false, error: LOST_REJECTED_MESSAGE };
  if (!isTargetDamageSeverity(s)) return { ok: false, error: "被害の程度を選んでください" };
  return { ok: true, value: s };
}

// メモ（任意）: 前後の空白を取る。空なら null。200 文字まで
export function parseDamageNote(input: string | null | undefined): Parse<string | null> {
  const s = (input ?? "").trim();
  if (s === "") return { ok: true, value: null };
  if (s.length > MAX_DAMAGE_NOTE_LENGTH) {
    return { ok: false, error: `メモは ${MAX_DAMAGE_NOTE_LENGTH} 文字以内で入力してください` };
  }
  return { ok: true, value: s };
}

// --- 圃場・株の被害の記録（画面 → Server Action） -----------------------------------

export type TargetDamageInput = {
  eventId: string; // 確定ごとに画面が採番する（同じ内容の再送は同じ id = 二重にならない）
  targetType: string;
  targetId: string;
  date: string;
  kind: string;
  severity: string;
  note: string;
};

export type ValidTargetDamage = {
  eventId: string;
  targetType: DamageTargetType;
  targetId: string;
  date: string;
  kind: DamageKind;
  severity: TargetDamageSeverity;
  note: string | null;
};

export type DamageErrors = {
  date?: string;
  kind?: string;
  severity?: string;
  note?: string;
  form?: string;
};

export function validateTargetDamage(
  input: TargetDamageInput,
  now: Date = new Date(),
): { ok: true; value: ValidTargetDamage } | { ok: false; errors: DamageErrors } {
  if (
    !input ||
    !UUID_PATTERN.test(input.eventId ?? "") ||
    !UUID_PATTERN.test(input.targetId ?? "") ||
    (input.targetType !== "field" && input.targetType !== "mat")
  ) {
    return { ok: false, errors: { form: RELOAD_MESSAGE } };
  }
  const date = parseDamageDate(input.date, now);
  const kind = parseDamageKind(input.kind);
  const severity = parseTargetDamageSeverity(input.severity);
  const note = parseDamageNote(input.note);
  if (!date.ok || !kind.ok || !severity.ok || !note.ok) {
    const errors: DamageErrors = {};
    if (!date.ok) errors.date = date.error;
    if (!kind.ok) errors.kind = kind.error;
    if (!severity.ok) errors.severity = severity.error;
    if (!note.ok) errors.note = note.error;
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      eventId: input.eventId,
      targetType: input.targetType,
      targetId: input.targetId,
      date: date.value,
      kind: kind.value,
      severity: severity.value,
      note: note.value,
    },
  };
}

// 確定の内容の識別子（画面で event_id を保持するか採番し直すかの判定に使う）
export function targetDamageKey(input: Omit<TargetDamageInput, "eventId">): string {
  return JSON.stringify([
    input.targetType,
    input.targetId,
    (input.date ?? "").trim(),
    input.kind,
    input.severity,
    (input.note ?? "").trim(),
  ]);
}

// events の 1 行（organization_id は渡さない。トリガー set_org_from_target が対象からコピーする）
export function targetDamageEventRow(value: ValidTargetDamage, occurredAt: string, recordedBy: string) {
  return {
    id: value.eventId,
    type: "damage" as const,
    target_type: value.targetType,
    target_id: value.targetId,
    occurred_at: occurredAt,
    recorded_by: recordedBy,
    payload: { kind: value.kind, severity: value.severity },
    note: value.note,
  };
}

// --- 圃場の被害から株へ一括 ----------------------------------------------------------

// 一括の元になる圃場の被害イベント（DB から読んだ行）
export type FieldDamageEvent = {
  id: string;
  type: string;
  target_type: string;
  target_id: string;
  occurred_at: string;
  payload: Record<string, unknown> | null;
  note: string | null;
  superseded_by: string | null;
};

// その圃場の、一括の元にできる被害イベントか（種類・程度が正しく、喪失でなく、訂正されていない）
export function checkFieldDamageEvent(
  event: FieldDamageEvent | null | undefined,
  fieldId: string,
): { ok: true; kind: DamageKind; severity: TargetDamageSeverity } | { ok: false; error: string } {
  if (!event || event.type !== "damage" || event.target_type !== "field" || event.target_id !== fieldId) {
    return { ok: false, error: "圃場の被害の記録が見つかりません" };
  }
  if (event.superseded_by !== null) return { ok: false, error: "この圃場の被害の記録は訂正済みです" };
  const kind = event.payload?.kind;
  const severity = event.payload?.severity;
  if (typeof kind !== "string" || !isDamageKind(kind)) return { ok: false, error: "被害の種類が正しくありません" };
  if (!isTargetDamageSeverity(severity)) return { ok: false, error: LOST_REJECTED_MESSAGE };
  return { ok: true, kind, severity };
}

// 一括の候補: 撤去していない株のうち、この圃場の被害から既に記録した株を除く（株コード順は呼び出し側の順のまま）
export function bulkDamageCandidates<T extends { id: string; status?: string | null }>(
  mats: readonly T[],
  alreadyRecordedMatIds: ReadonlySet<string>,
): T[] {
  return mats.filter((m) => m.status !== "removed" && !alreadyRecordedMatIds.has(m.id));
}

// 一覧の株から、外した株を除いた対象（一覧の順）
export function selectedMatIds(matIds: readonly string[], excluded: ReadonlySet<string>): string[] {
  return matIds.filter((id) => !excluded.has(id));
}

export type BulkDamageInput = {
  batchId: string; // 確定ごとに画面が採番する（同じ内容の再送は同じ batch_id = 二重にならない）
  fieldId: string;
  fieldEventId: string;
  matIds: string[];
};

export const NO_TARGET_MESSAGE = "対象の株を 1 株以上選んでください";

export function validateBulkDamage(
  input: BulkDamageInput,
): { ok: true; value: BulkDamageInput } | { ok: false; errors: { targets?: string; form?: string } } {
  if (
    !input ||
    !UUID_PATTERN.test(input.batchId ?? "") ||
    !UUID_PATTERN.test(input.fieldId ?? "") ||
    !UUID_PATTERN.test(input.fieldEventId ?? "")
  ) {
    return { ok: false, errors: { form: RELOAD_MESSAGE } };
  }
  const matIds = Array.isArray(input.matIds) ? input.matIds : [];
  if (matIds.length === 0) return { ok: false, errors: { targets: NO_TARGET_MESSAGE } };
  const seen = new Set<string>();
  for (const id of matIds) {
    if (typeof id !== "string" || !UUID_PATTERN.test(id) || seen.has(id)) {
      return { ok: false, errors: { targets: RELOAD_MESSAGE } };
    }
    seen.add(id);
  }
  return {
    ok: true,
    value: { batchId: input.batchId, fieldId: input.fieldId, fieldEventId: input.fieldEventId, matIds: [...matIds] },
  };
}

// 確定の内容の識別子（画面で batch_id を保持するか採番し直すかの判定に使う）。対象の株は一覧の順
export function bulkDamageKey(input: Omit<BulkDamageInput, "batchId">): string {
  return JSON.stringify([input.fieldId, input.fieldEventId, input.matIds]);
}

// 株ごとの damage イベントの行。内容（日付・種類・程度・メモ）は圃場の被害イベントと同じ
// （画面からは株の id だけを受け取り、内容はサーバーが圃場の被害イベントから取る）
export function bulkMatDamageRows(
  fieldEvent: Pick<FieldDamageEvent, "id" | "occurred_at" | "note">,
  content: { kind: DamageKind; severity: TargetDamageSeverity },
  matIds: readonly string[],
  batchId: string,
  recordedBy: string,
) {
  return matIds.map((matId) => ({
    type: "damage" as const,
    target_type: "mat" as const,
    target_id: matId,
    occurred_at: fieldEvent.occurred_at,
    recorded_by: recordedBy,
    payload: { kind: content.kind, severity: content.severity, field_event_id: fieldEvent.id, batch_id: batchId },
    note: fieldEvent.note,
  }));
}

export function bulkDamageSummaryText(count: number): string {
  return `${count} 株に被害を記録`;
}
