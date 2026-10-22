// 送信失敗の扱い（純粋関数）。offline-sync.md 4 章。
//
// - ネットワークの失敗（fetch の TypeError、圏外、5xx、408/429）は再試行する。指数バックオフ 1s, 2s, 4s … 上限 1 分
// - 認証エラー（401/403）とバリデーション系（4xx、PostgREST / PostgreSQL のエラーコード。RPC の状態前提違反など）は
//   再送しても直らないので、再試行せず即「要確認」にする
// - 再試行が MAX_AUTO_ATTEMPTS 回失敗したら「要確認」。要確認は手動で再試行できる
import type { OutboxItem, SendError } from "./types";

export const MAX_AUTO_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

export type FailureKind = "retry" | "manual";

const NETWORK_MESSAGE = /fetch failed|failed to fetch|load failed|networkerror|network request failed|network error|econnre|etimedout|timed? ?out|socket hang up|offline/i;
const NETWORK_NAMES = new Set(["TypeError", "FetchError", "AbortError", "TimeoutError", "StorageUnknownError"]);

// 失敗を「再試行する」か「要確認（再送しても直らない）」かに分ける
export function classifySendError(error: SendError, online: boolean): FailureKind {
  const status = error.status ?? null;
  if (status !== null && status > 0) {
    if (status === 408 || status === 429) return "retry";
    if (status >= 500) return "retry";
    if (status >= 400) return "manual"; // 401/403 の認証エラー、400/409/422 のバリデーション
  }
  const code = (error.code ?? "").trim();
  if (code !== "") {
    // PostgREST（PGRSTxxx）と PostgreSQL の SQLSTATE（raise exception の P0001、制約違反 23xxx、権限 42501 など）
    if (/^PGRST\d+$/i.test(code)) return "manual";
    if (/^[0-9A-Z]{5}$/.test(code)) return "manual";
  }
  if (!online) return "retry";
  if (error.name && NETWORK_NAMES.has(error.name)) return "retry";
  if (NETWORK_MESSAGE.test(error.message)) return "retry";
  // 分類できないものは再試行（MAX_AUTO_ATTEMPTS で止まる）
  return "retry";
}

// n 回目の失敗の後に待つ時間（1s, 2s, 4s … 上限 1 分）
export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS);
}

// 失敗後の項目の状態
export function afterFailure(item: OutboxItem, error: SendError, online: boolean, now: number): OutboxItem {
  const attempts = item.attempts + 1;
  const kind = classifySendError(error, online);
  const needsAttention = kind === "manual" || attempts >= MAX_AUTO_ATTEMPTS;
  return {
    ...item,
    attempts,
    last_error: describeSendError(error),
    needs_attention: needsAttention ? 1 : 0,
    next_attempt_at: needsAttention ? null : now + backoffMs(attempts),
  } as OutboxItem;
}

// 手動で再試行するときの状態（要確認を外し、すぐ送る）。attempts は通算の失敗回数として残す
// （再試行してまた失敗すれば、ネットワーク失敗でも attempts >= MAX なので即「要確認」に戻る）
export function forRetry(item: OutboxItem): OutboxItem {
  return { ...item, needs_attention: 0, next_attempt_at: null } as OutboxItem;
}

// いま送ってよい項目か（要確認でなく、バックオフ中でもない）
export function isDue(item: OutboxItem, now: number): boolean {
  if (item.needs_attention === 1) return false;
  return item.next_attempt_at === null || item.next_attempt_at <= now;
}

export function describeSendError(error: SendError): string {
  const prefix = error.code ? `[${error.code}] ` : error.status ? `[${error.status}] ` : "";
  return `${prefix}${error.message}`.trim() || "不明なエラー";
}

// 何でも SendError にする（supabase-js のエラーオブジェクト、Error、文字列）
export function toSendError(err: unknown, status?: number | null): SendError {
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const statusCode =
      typeof o.status === "number" ? o.status : typeof o.statusCode === "string" ? Number(o.statusCode) : typeof o.statusCode === "number" ? o.statusCode : null;
    return {
      message: typeof o.message === "string" ? o.message : String(err),
      code: typeof o.code === "string" ? o.code : null,
      status: status ?? (Number.isFinite(statusCode) ? statusCode : null),
      name: typeof o.name === "string" ? o.name : null,
    };
  }
  return { message: String(err), status: status ?? null };
}
