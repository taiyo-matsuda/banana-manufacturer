import { describe, expect, it } from "vitest";
import { defaultCultivarId } from "./default-cultivar";

describe("defaultCultivarId", () => {
  it("株がなければ fallback", () => {
    expect(defaultCultivarId([], "fallback")).toBe("fallback");
  });

  it("最後に登録した株の品種（配列の順ではなく created_at で決める）", () => {
    const mats = [
      { cultivar_id: "c-new", created_at: "2026-10-20T03:00:00+00:00" },
      { cultivar_id: "c-old", created_at: "2026-10-01T00:00:00+00:00" },
      { cultivar_id: "c-mid", created_at: "2026-10-10T00:00:00+00:00" },
    ];
    expect(defaultCultivarId(mats, "fallback")).toBe("c-new");
    expect(defaultCultivarId([...mats].reverse(), "fallback")).toBe("c-new");
  });
});
