import { describe, expect, it } from "vitest";
import { resolveAuthRedirect } from "./redirect";

describe("resolveAuthRedirect", () => {
  it("未ログインで / を開くと /login へ", () => {
    expect(resolveAuthRedirect("/", false)).toBe("/login");
  });
  it("未ログインで /login はそのまま", () => {
    expect(resolveAuthRedirect("/login", false)).toBeNull();
  });
  it("未ログインで深いパスも /login へ", () => {
    expect(resolveAuthRedirect("/mats/abc", false)).toBe("/login");
  });
  it("ログイン済みで /login を開くと / へ", () => {
    expect(resolveAuthRedirect("/login", true)).toBe("/");
  });
  it("ログイン済みで / はそのまま", () => {
    expect(resolveAuthRedirect("/", true)).toBeNull();
  });
});
