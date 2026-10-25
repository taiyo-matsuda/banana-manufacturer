// 株の撤去（2-3、要確認 11）。撤去できるかの判定と撤去済みの表示。UI・DB に依存しない純粋関数。
//
// 撤去は RPC remove_mat（supabase/migrations/0012_remove_mat.sql）が 1 トランザクションで mats.status=removed と
// mat_removed イベントを書く。判定の正本は DB（下の表と同じ条件で例外を出す）。片方を変えたら両方を変える。
// ここは画面の事前判定（撤去のボタンを出すか・理由を出すか）に使う。

// 栽培中の茎（撤去できない）
export const GROWING_STEM_STATUSES = ["active", "flowered"] as const;
// 未処理の吸芽（芽かき・株分け・採用のどれかを先に決めてもらう）
export const PENDING_SUCKER_STATUS = "sucker";

export const REMOVE_BLOCKED_GROWING =
  "栽培中の茎があるため撤去できません。先に収穫・喪失などで茎を終えてください";
export const REMOVE_BLOCKED_SUCKER =
  "未処理の吸芽があるため撤去できません。先に吸芽の芽かき・株分け・採用を決めてください";
export const REMOVE_ALREADY_REMOVED = "この株は既に撤去済みです";

export const MAX_REMOVE_REASON_LENGTH = 500;

export type RemoveCheck = { ok: true } | { ok: false; reason: string };

export function canRemoveMat(mat: { status: string }, stems: readonly { status: string }[]): RemoveCheck {
  if (mat.status === "removed") return { ok: false, reason: REMOVE_ALREADY_REMOVED };
  if (stems.some((s) => (GROWING_STEM_STATUSES as readonly string[]).includes(s.status))) {
    return { ok: false, reason: REMOVE_BLOCKED_GROWING };
  }
  if (stems.some((s) => s.status === PENDING_SUCKER_STATUS)) return { ok: false, reason: REMOVE_BLOCKED_SUCKER };
  return { ok: true };
}

// 理由（任意のメモ）: 前後の空白を取り、空なら null
export type ReasonParse = { ok: true; value: string | null } | { ok: false; error: string };
export function parseRemoveReason(input: string | null | undefined): ReasonParse {
  const v = (input ?? "").trim();
  if (v.length > MAX_REMOVE_REASON_LENGTH) {
    return { ok: false, error: `理由は ${MAX_REMOVE_REASON_LENGTH} 文字以内で入力してください` };
  }
  return { ok: true, value: v === "" ? null : v };
}

// 株の詳細の上部に出す「撤去済み（日付・理由）」。日付は日本時間。イベントが見つからなければ日付・理由なし
const jstDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
export function removedMatLabel(event: { occurred_at: string; payload: unknown } | null): string {
  if (!event) return "撤去済み";
  const at = new Date(event.occurred_at);
  const date = Number.isNaN(at.getTime()) ? null : jstDate.format(at);
  const payload = event.payload as { reason?: unknown } | null;
  const reason = typeof payload?.reason === "string" && payload.reason.trim() !== "" ? payload.reason.trim() : null;
  const parts = [date, reason].filter((p): p is string => p !== null);
  return parts.length > 0 ? `撤去済み（${parts.join("・")}）` : "撤去済み";
}
