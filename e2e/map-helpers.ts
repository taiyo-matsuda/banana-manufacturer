import type { Locator, Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, randomFieldCode, supabaseAsA, test } from "./helpers";

// 地図系 spec（map.spec.ts / mat.spec.ts）で共有する補助関数。
// テストが作る圃場の名前は必ず `E2E` で始める（auth.setup.ts の掃除で消えるため）。

export const CENTER = { lat: 26.5, lng: 127.9 };

export function uniqueName(prefix = "E2E地図") {
  return `${prefix}-${test.info().project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// テスト用の圃場を DB に直接作る（1-2 で登録画面は検証済み）
export async function createField(prefix?: string) {
  const supabase = await supabaseAsA();
  const code = randomFieldCode();
  const { data, error } = await supabase
    .from("fields")
    .insert({ name: uniqueName(prefix), code, center_lat: CENTER.lat, center_lng: CENTER.lng })
    .select("id, code")
    .single();
  if (error || !data) throw new Error(`圃場を作れません: ${error?.message}`);
  return { supabase, id: data.id as string, code: data.code as string };
}

export async function openMap(page: Page, fieldId: string) {
  // 圃場の詳細から導線で地図へ
  await page.goto(`/fields/${fieldId}`);
  await page.getByRole("link", { name: "地図（株の配置）" }).click();
  await expect(page).toHaveURL(`/fields/${fieldId}/map`);
  // 地図は Client Component（next/dynamic, ssr:false）で、開発サーバーでは初回表示に Turbopack のコンパイルと
  // MapLibre の読み込みがかかる。他のテストと並行して走ると 5 秒を超えることがあるので ACTION_TIMEOUT で待つ
  const map = page.getByTestId("field-map");
  await expect(map).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(map).toHaveAttribute("data-map-ready", "true", { timeout: ACTION_TIMEOUT });
  return map;
}

export async function canvasCenter(map: Locator) {
  const box = await map.boundingBox();
  if (!box) throw new Error("地図の大きさが取れません");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
