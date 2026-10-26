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

describe("resolveAuthRedirect（公開パス）", () => {
  it("未ログインで /offline は /login に転送しない（SW がプリキャッシュできるように）", () => {
    expect(resolveAuthRedirect("/offline", false)).toBeNull();
  });
  it("ログイン済みで /offline もそのまま", () => {
    expect(resolveAuthRedirect("/offline", true)).toBeNull();
  });
  it("/offline の下のパスは公開しない", () => {
    expect(resolveAuthRedirect("/offline/x", false)).toBe("/login");
  });
  it("オフラインの殻（2-9）/offline-shell も未ログインで転送しない（SW がプリキャッシュできるように）。下のパスは公開しない", () => {
    expect(resolveAuthRedirect("/offline-shell", false)).toBeNull();
    expect(resolveAuthRedirect("/offline-shell", true)).toBeNull();
    expect(resolveAuthRedirect("/offline-shell/x", false)).toBe("/login");
  });
  it("気温の日次取り込み（3-1）/api/cron/weather は未ログインでも転送しない（Route Handler がシークレットで認証する）。下のパスは公開しない", () => {
    expect(resolveAuthRedirect("/api/cron/weather", false)).toBeNull();
    expect(resolveAuthRedirect("/api/cron/weather/x", false)).toBe("/login");
    expect(resolveAuthRedirect("/api/cron", false)).toBe("/login");
  });
});
