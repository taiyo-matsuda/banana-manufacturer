import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { AUTH_STATE_A } from "./e2e/helpers";

// E2E 用の環境変数（Supabase の URL / key、テスト用アカウント A / B）を .env.local から読む
loadEnv({ path: path.resolve(__dirname, ".env.local") });

// E2E テスト。レビュー用サブエージェントが実行し、合格したときだけ次のタスクに進む。
// 対象は iPhone の PWA なので、モバイル Safari 相当のビューポートを既定にする。
export default defineConfig({
  testDir: "./e2e",
  // 実行前の準備（Windows の TIME_WAIT 待ち）。ログインと E2E データの掃除は setup プロジェクトで行う
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  // 既定は CPU 数 / 2 で環境ごとに変わる。開発サーバー（Turbopack）1 台と Supabase に対して多すぎると
  // Server Action の応答が遅くなるので固定する（iphone / desktop の 2 プロジェクトが 1 つずつ走る）
  workers: 2,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],
  use: {
    // localhost ではなく 127.0.0.1 にする。localhost は IPv6 の [::1] で繋がり、E2E 1 回で数千の TIME_WAIT が
    // IPv6 の動的ポート（16,384 個）を使い切って `fetch failed` になった（Supabase への fetch も IPv6 で出ていく）
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // ログインは setup プロジェクト（e2e/auth.setup.ts）で A / B に 1 回ずつ行い、Cookie を e2e/.auth/ に保存して
  // 全テストで共有する。Supabase Auth のサインインは IP ごとにレート制限があり、テストごとにログインすると
  // 1 回の実行で上限を超えてログインに失敗する。
  projects: [
    {
      name: "setup",
      testMatch: /auth.setup.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "iphone",
      use: { ...devices["iPhone 14"], browserName: "chromium", storageState: AUTH_STATE_A },
      dependencies: ["setup"],
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], storageState: AUTH_STATE_A },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "npm run dev -- -H 127.0.0.1",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
