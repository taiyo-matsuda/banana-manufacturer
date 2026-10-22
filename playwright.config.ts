import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import path from "node:path";

// E2E 用の環境変数（Supabase の URL / key、テスト用アカウント A / B）を .env.local から読む
loadEnv({ path: path.resolve(__dirname, ".env.local") });

// E2E テスト。レビュー用サブエージェントが実行し、合格したときだけ次のタスクに進む。
// 対象は iPhone の PWA なので、モバイル Safari 相当のビューポートを既定にする。
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "iphone",
      use: { ...devices["iPhone 14"], browserName: "chromium" },
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
