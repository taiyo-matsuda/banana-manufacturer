import "server-only";

import { jstDateOf } from "./dates";
import { createMockFetch, parseMockFault, type MockFault } from "./mock";
import type { FetchFn } from "./open-meteo";

// Open-Meteo のモック（E2E 用）を使うか。開発サーバー（next dev）で WEATHER_MOCK=1 のときだけ。
// 本番（NODE_ENV=production の next build / next start、Vercel）では環境変数があっても効かない。
export function weatherMockEnabled(): boolean {
  return (
    process.env.WEATHER_MOCK === "1" &&
    process.env.NODE_ENV !== "production" &&
    !process.env.VERCEL
  );
}

// E2E が失敗を起こさせる指定（Cookie / ヘッダ e2e-weather-fault）。モックのときだけ読む
export const MOCK_FAULT_NAME = "e2e-weather-fault";

export function mockFaultFrom(value: string | null | undefined): MockFault {
  return weatherMockEnabled() ? parseMockFault(value) : null;
}

// 取り込みに使う fetch。本番は Open-Meteo（グローバルの fetch）、E2E の開発サーバーはモック
export function weatherFetcher(fault: MockFault = null, now: Date = new Date()): FetchFn {
  if (weatherMockEnabled()) return createMockFetch({ today: jstDateOf(now), fault });
  return (input, init) => fetch(input, init);
}
