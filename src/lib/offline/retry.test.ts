import { describe, expect, it } from "vitest";
import { newObservationItem } from "./items";
import { afterFailure, backoffMs, classifySendError, forRetry, isDue, MAX_AUTO_ATTEMPTS, toSendError } from "./retry";

const item = () =>
  newObservationItem({
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: new Date("2026-10-23T00:00:00Z"),
    stemId: "stem-1",
    type: "leaves_new",
    value: 1,
    observedAt: new Date("2026-10-23T00:00:00Z"),
    userId: "user-1",
  });

describe("classifySendError（再試行するか、要確認にするか）", () => {
  it("ネットワークの失敗（fetch の TypeError、圏外、5xx、408/429）は再試行", () => {
    expect(classifySendError({ message: "TypeError: Failed to fetch", code: "", status: 0 }, true)).toBe("retry");
    expect(classifySendError({ message: "fetch failed", name: "TypeError" }, true)).toBe("retry");
    expect(classifySendError({ message: "Load failed", name: "TypeError" }, true)).toBe("retry");
    expect(classifySendError({ message: "何か", status: 503 }, true)).toBe("retry");
    expect(classifySendError({ message: "何か", status: 502 }, true)).toBe("retry");
    expect(classifySendError({ message: "何か", status: 429 }, true)).toBe("retry");
    expect(classifySendError({ message: "何か", status: 408 }, true)).toBe("retry");
    expect(classifySendError({ message: "不明", name: "StorageUnknownError" }, true)).toBe("retry");
    // 圏外なら中身によらず再試行
    expect(classifySendError({ message: "不明" }, false)).toBe("retry");
  });

  it("認証エラー（401 / 403）は再試行せず要確認", () => {
    expect(classifySendError({ message: "JWT expired", code: "PGRST301", status: 401 }, true)).toBe("manual");
    expect(classifySendError({ message: "Unauthorized", status: 401 }, true)).toBe("manual");
    expect(classifySendError({ message: "Forbidden", status: 403 }, true)).toBe("manual");
  });

  it("バリデーション系（4xx、PostgREST / PostgreSQL のエラーコード。RPC の状態前提違反）は要確認", () => {
    // RPC の raise exception（P0001、HTTP 400）
    expect(classifySendError({ message: "袋掛けは出蕾済みの茎にだけ記録できます（この茎は栽培中）", code: "P0001", status: 400 }, true)).toBe("manual");
    // 制約違反、RLS、PostgREST
    expect(classifySendError({ message: "duplicate key", code: "23505", status: 409 }, true)).toBe("manual");
    expect(classifySendError({ message: "new row violates row-level security policy", code: "42501", status: 403 }, true)).toBe("manual");
    expect(classifySendError({ message: "invalid input", code: "22P02", status: 400 }, true)).toBe("manual");
    expect(classifySendError({ message: "not found", code: "PGRST116" }, true)).toBe("manual");
    expect(classifySendError({ message: "Bad Request", status: 400 }, true)).toBe("manual");
    expect(classifySendError({ message: "Unprocessable", status: 422 }, true)).toBe("manual");
    // status がなくてもコードがあれば要確認（PostgREST のエラー）
    expect(classifySendError({ message: "x", code: "P0001" }, true)).toBe("manual");
  });
});

describe("backoffMs（指数バックオフ 1s, 2s, 4s … 上限 1 分）", () => {
  it("1 回目 1s、2 回目 2s、3 回目 4s、… 上限 60s", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(6)).toBe(32_000);
    expect(backoffMs(7)).toBe(60_000);
    expect(backoffMs(20)).toBe(60_000);
    expect(backoffMs(0)).toBe(1_000);
  });
});

describe("afterFailure / isDue / forRetry", () => {
  const now = 1_000_000;

  it("ネットワーク失敗: attempts を増やし last_error を保持し、バックオフ後に再試行", () => {
    const a = afterFailure(item(), { message: "fetch failed", name: "TypeError" }, true, now);
    expect(a.attempts).toBe(1);
    expect(a.needs_attention).toBe(0);
    expect(a.last_error).toBe("fetch failed");
    expect(a.next_attempt_at).toBe(now + 1_000);
    expect(isDue(a, now)).toBe(false);
    expect(isDue(a, now + 999)).toBe(false);
    expect(isDue(a, now + 1_000)).toBe(true);

    const b = afterFailure(a, { message: "fetch failed", name: "TypeError" }, true, now + 1_000);
    expect(b.attempts).toBe(2);
    expect(b.next_attempt_at).toBe(now + 1_000 + 2_000);
  });

  it(`${MAX_AUTO_ATTEMPTS} 回失敗したら要確認（自動では送らない）`, () => {
    let it_ = item();
    for (let i = 0; i < MAX_AUTO_ATTEMPTS - 1; i++) {
      it_ = afterFailure(it_, { message: "fetch failed", name: "TypeError" }, true, now);
      expect(it_.needs_attention).toBe(0);
    }
    it_ = afterFailure(it_, { message: "fetch failed", name: "TypeError" }, true, now);
    expect(it_.attempts).toBe(MAX_AUTO_ATTEMPTS);
    expect(it_.needs_attention).toBe(1);
    expect(it_.next_attempt_at).toBeNull();
    expect(isDue(it_, now + 10 * 60_000)).toBe(false);
  });

  it("認証・バリデーションの失敗は 1 回目で要確認。last_error にコードとメッセージ", () => {
    const a = afterFailure(item(), { message: "出蕾は栽培中の茎にだけ記録できます（この茎は出蕾済み）", code: "P0001", status: 400 }, true, now);
    expect(a.attempts).toBe(1);
    expect(a.needs_attention).toBe(1);
    expect(a.next_attempt_at).toBeNull();
    expect(a.last_error).toBe("[P0001] 出蕾は栽培中の茎にだけ記録できます（この茎は出蕾済み）");
  });

  it("手動の再試行は要確認を外して即時に送る。attempts（通算の失敗回数）と前回の理由は残す", () => {
    const failed = afterFailure(item(), { message: "x", status: 401 }, true, now);
    const r = forRetry(failed);
    expect(r.needs_attention).toBe(0);
    expect(r.attempts).toBe(1);
    expect(r.next_attempt_at).toBeNull();
    expect(r.last_error).toBe("[401] x");
    expect(isDue(r, now)).toBe(true);
    // また失敗すれば 2 回目として要確認に戻る
    const again = afterFailure(r, { message: "x", status: 401 }, true, now);
    expect(again).toMatchObject({ attempts: 2, needs_attention: 1 });
  });
});

describe("toSendError（supabase-js のエラーの正規化）", () => {
  it("PostgrestError（code / message）と status", () => {
    expect(toSendError({ message: "m", code: "P0001", details: "", hint: "" }, 400)).toEqual({ message: "m", code: "P0001", status: 400, name: null });
  });
  it("StorageApiError（statusCode が文字列）", () => {
    expect(toSendError({ name: "StorageApiError", message: "Unauthorized", status: 401, statusCode: "401" })).toMatchObject({
      message: "Unauthorized",
      status: 401,
      name: "StorageApiError",
    });
    expect(toSendError({ name: "StorageApiError", message: "x", statusCode: "403" })).toMatchObject({ status: 403 });
  });
  it("TypeError と文字列", () => {
    expect(toSendError(new TypeError("Failed to fetch"))).toMatchObject({ message: "Failed to fetch", name: "TypeError", status: null });
    expect(toSendError("boom")).toEqual({ message: "boom", status: null });
  });
});
