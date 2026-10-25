import { beforeEach, describe, expect, it, vi } from "vitest";

// server-only・Supabase のサーバー用クライアント・next/navigation の redirect を差し替える
vi.mock("server-only", () => ({}));
const getUser = vi.fn();
vi.mock("../supabase/server", () => ({
  createClient: async () => ({ auth: { getUser } }),
}));
class RedirectError extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
}));

const { getCurrentUser, requireUser, userOrRedirect } = await import("./current-user");

const user = { id: "11111111-1111-1111-1111-111111111111" } as never;

beforeEach(() => {
  getUser.mockReset();
});

describe("getCurrentUser", () => {
  it("getUser() のユーザーを返す", async () => {
    getUser.mockResolvedValue({ data: { user }, error: null });
    await expect(getCurrentUser()).resolves.toBe(user);
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("未ログインなら null（redirect はしない。Action が自分のエラーを返せる）", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: "Auth session missing!" } });
    await expect(getCurrentUser()).resolves.toBeNull();
  });
});

describe("requireUser", () => {
  it("ログインしていればユーザーを返す", async () => {
    getUser.mockResolvedValue({ data: { user }, error: null });
    await expect(requireUser()).resolves.toBe(user);
  });

  it("未ログインなら /login へ redirect する", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(requireUser()).rejects.toMatchObject({ url: "/login" });
  });
});

describe("userOrRedirect", () => {
  it("ユーザーがあればそのまま返す", () => {
    expect(userOrRedirect(user)).toBe(user);
  });

  it("null なら /login へ redirect する", () => {
    expect(() => userOrRedirect(null)).toThrow(RedirectError);
    try {
      userOrRedirect(null);
    } catch (e) {
      expect((e as RedirectError).url).toBe("/login");
    }
  });
});
