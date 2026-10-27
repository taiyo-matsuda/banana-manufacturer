import { defineConfig, devices } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { AUTH_STATE_A } from "./e2e/helpers";
import { assertLocalSupabaseUrl } from "./e2e/local-supabase";

// E2E 用の環境変数（Supabase の URL / key、テスト用アカウント A / B）を .env.local から読む
loadEnv({ path: path.resolve(__dirname, ".env.local") });

// E2E は手元の Supabase（`npx supabase start`）でだけ流す。URL が本番（リモート）なら、開発サーバーを起動する前に止める
// （本番の無料枠を使わないため）。起動しているかの確認は global-setup.ts が行う
assertLocalSupabaseUrl();

// 気温の取り込み（3-1）: Cron の Route Handler のシークレット。.env.local に無ければ E2E の開発サーバー用の値を使う
// （下の webServer.env で開発サーバーにも同じ値を渡す。テストは process.env.CRON_SECRET を読む）。
// SUPABASE_SERVICE_ROLE_KEY は手元の Supabase の service_role（`npx supabase status`）を .env.local に置く。無ければ global-setup が止める。
process.env.CRON_SECRET ??= "e2e-local-cron-secret";

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
  // 開発サーバー（Turbopack）で、並行実行中は画面の表示や Server Action の応答が既定の 5 秒を超えることがある
  // （リモートの Supabase を使っていた頃は遅い時間帯に全テストが 2〜3 倍遅くなった）。個別に延ばすのではなく全体で 15 秒にする
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],
  use: {
    // localhost ではなく 127.0.0.1 にする。localhost は IPv6 の [::1] で繋がり、E2E 1 回で数千の TIME_WAIT が
    // IPv6 の動的ポート（16,384 個）を使い切って `fetch failed` になった（Supabase への fetch も IPv6 で出ていく）
    baseURL: "http://127.0.0.1:3000",
    actionTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // ログインは setup プロジェクト（e2e/auth.setup.ts）で A / B に 1 回ずつ行い、Cookie を e2e/.auth/ に保存して
  // 全テストで共有する。Supabase Auth のサインインは IP ごとにレート制限があり、テストごとにログインすると
  // 1 回の実行で上限を超えてログインに失敗する（手元の Supabase では config.toml で緩めてあるが、本番と同じ前提で書く）。
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
    // WEATHER_MOCK=1: 気温の取り込みは Open-Meteo ではなくモック（src/lib/weather/mock.ts）を使う。
    // 開発サーバー（NODE_ENV=development）でだけ効く（src/lib/weather/server.ts）。本番の挙動は変わらない。
    // 既に起動している開発サーバーを再利用したときはこの env は渡らない（weather.spec が検出して失敗させる）
    env: { WEATHER_MOCK: "1", CRON_SECRET: process.env.CRON_SECRET },
  },
});
