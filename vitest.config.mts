import { defineConfig } from "vitest/config";

// 単体テスト。対象は src/lib（UI に依存しないドメインロジック）。
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
