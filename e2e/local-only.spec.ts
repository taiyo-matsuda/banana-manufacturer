import type { Page, Request } from "@playwright/test";
import { ACTION_TIMEOUT, env, expect, test, waitForSynced } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";

// 0-3 E2E と開発を手元の Supabase へ。完了条件 3「本番（リモート）の Supabase には一切アクセスしない
// （E2E 中の通信先が 127.0.0.1 だけ）」を、ブラウザから出た通信で確かめる。
// 主要な画面を巡回し、茎の記録（端末の outbox → 同期で Supabase に送る）まで行って、
// - *.supabase.co / *.supabase.in への通信が 0 件
// - Supabase の API（/auth/v1・/rest/v1・/storage/v1・/realtime/v1）への通信が 1 件以上あり、全て手元（127.0.0.1:54321）
// であることを検証する。地理院タイルや Open-Meteo（E2E ではモック）など Supabase 以外の外部通信は対象外。
// サーバー側（Next.js → Supabase）の通信は同じ .env.local の URL を使い、その URL が手元であることは
// global-setup（e2e/local-supabase.ts）が実行の前に確かめている。

const SUPABASE_PATHS = /^\/(auth|rest|storage|realtime)\/v1\//;

function isRemoteSupabaseHost(host: string) {
  return /(^|\.)supabase\.(co|in)$/i.test(host);
}

const view = (page: Page) => page.locator("main:visible");

test("主要な画面を巡回して記録しても、Supabase への通信は手元（127.0.0.1）だけで、*.supabase.co への通信は 0 件", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const localOrigin = new URL(env("NEXT_PUBLIC_SUPABASE_URL")).origin;
  expect(new URL(localOrigin).hostname).toBe("127.0.0.1");

  const field = await createField("E2E通信先");
  const matCode = `${field.code}-001`;
  const matId = await createMat(field.id, matCode);
  const stemId = await createStem(matId, { initialLeafCount: 4 });

  const requests: { url: URL; method: string }[] = [];
  const record = (req: Request) => {
    try {
      requests.push({ url: new URL(req.url()), method: req.method() });
    } catch {
      // data: / blob: など URL として読めないものは対象外
    }
  };
  page.context().on("request", record);

  for (const path of ["/", "/fields", `/fields/${field.id}`, `/mats/${matId}`, "/weekly", "/forecast"]) {
    await page.goto(path);
    await expect(page.getByText("読み込み中…")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  }

  // 地図（地理院タイル・MapLibre）
  await page.goto(`/fields/${field.id}/map`);
  await expect(page.getByTestId("field-map")).toHaveAttribute("data-map-ready", "true", { timeout: ACTION_TIMEOUT });

  // 茎の記録: +1 → 端末の outbox から同期で Supabase に送られる（ブラウザ → Supabase の通信が起きる）
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(matCode);
  await view(page).getByTestId("leaves-new-1").click();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("5", { timeout: ACTION_TIMEOUT });
  await waitForSynced(page);

  page.context().off("request", record);

  const remote = requests.filter((r) => isRemoteSupabaseHost(r.url.hostname));
  expect(remote.map((r) => `${r.method} ${r.url.href}`)).toEqual([]);

  const supabaseApi = requests.filter((r) => SUPABASE_PATHS.test(r.url.pathname));
  expect(supabaseApi.length).toBeGreaterThan(0);
  const notLocal = supabaseApi.filter((r) => r.url.origin !== localOrigin);
  expect(notLocal.map((r) => `${r.method} ${r.url.href}`)).toEqual([]);
});
