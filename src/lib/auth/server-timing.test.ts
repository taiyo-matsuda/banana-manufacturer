import { describe, expect, it } from "vitest";
import { authServerTiming } from "./server-timing";

describe("authServerTiming", () => {
  it("認証の時間（小数 1 桁）とリージョンを Server-Timing の形で返す", () => {
    expect(authServerTiming(1.234, "hnd1")).toBe('auth;dur=1.2;desc="hnd1"');
    expect(authServerTiming(250, "iad1")).toBe('auth;dur=250;desc="iad1"');
  });

  it("リージョンがなければ local", () => {
    expect(authServerTiming(3, undefined)).toBe('auth;dur=3;desc="local"');
    expect(authServerTiming(3, "")).toBe('auth;dur=3;desc="local"');
  });

  it("desc を壊す文字（\" と \\）は取り除く", () => {
    expect(authServerTiming(3, 'a"b\\c')).toBe('auth;dur=3;desc="abc"');
  });

  it("負・非数の時間は 0 にする", () => {
    expect(authServerTiming(-1, "hnd1")).toBe('auth;dur=0;desc="hnd1"');
    expect(authServerTiming(Number.NaN, "hnd1")).toBe('auth;dur=0;desc="hnd1"');
  });
});
