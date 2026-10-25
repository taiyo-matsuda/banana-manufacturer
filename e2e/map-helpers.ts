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

export async function dwarfNamwaId() {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("cultivars")
    .select("id")
    .eq("name", "ドワーフナムワ")
    .single();
  if (error || !data) throw new Error(`品種を取得できません: ${error?.message}`);
  return data.id as string;
}

// 株を DB に直接作る（株の追加 UI は 1-4 で検証済み。茎の検証は株の詳細だけを見たい）。
// 位置（at）を省くと圃場の代表点（CENTER）。地図の上で株を見分けたいテスト（2-3 の位置の修正）は離して置く
export async function createMat(fieldId: string, code: string, plantedAt = "2026-09-15", at: { lat: number; lng: number } = CENTER) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("mats")
    .insert({
      field_id: fieldId,
      code,
      cultivar_id: await dwarfNamwaId(),
      lat: at.lat,
      lng: at.lng,
      planted_at: plantedAt,
      origin_type: "tissue_culture",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`株を作れません: ${error?.message}`);
  return data.id as string;
}

type Field = Awaited<ReturnType<typeof createField>>;

// 株をまとめて DB に作る（施肥 2-4・被害の一括 2-5 で共通）（コードは `<圃場記号>-001` から連番）。株コード順 = 作った順
export async function createMats(field: Field, count: number) {
  const supabase = await supabaseAsA();
  const cultivarId = await dwarfNamwaId();
  const rows = Array.from({ length: count }, (_, i) => ({
    field_id: field.id,
    code: `${field.code}-${String(i + 1).padStart(3, "0")}`,
    cultivar_id: cultivarId,
    lat: CENTER.lat,
    lng: CENTER.lng,
    planted_at: "2026-09-15",
    origin_type: "tissue_culture",
  }));
  const { data, error } = await supabase.from("mats").insert(rows).select("id, code").order("code");
  if (error || !data) throw new Error(`株を作れません: ${error?.message}`);
  return data as { id: string; code: string }[];
}

export async function fieldWithMats(prefix: string, count: number) {
  const field = await createField(prefix);
  const mats = await createMats(field, count);
  return { field, mats };
}

// 茎を DB に直接作る（茎の登録 UI は 1-5 で検証済み。葉数の記録などは茎の画面だけを見たい）
export async function createStem(
  matId: string,
  options: {
    generation?: number;
    parentStemId?: string | null;
    status?: "sucker" | "active" | "flowered" | "harvested" | "removed" | "transplanted" | "lost";
    startedAt?: string;
    initialLeafCount?: number | null;
  } = {},
) {
  const supabase = await supabaseAsA();
  const { generation = 1, parentStemId = null, status = "active", startedAt = "2026-09-15", initialLeafCount = 2 } = options;
  const { data, error } = await supabase
    .from("stems")
    .insert({
      mat_id: matId,
      generation,
      parent_stem_id: parentStemId,
      status,
      started_at: startedAt,
      adopted_at: status === "sucker" ? null : startedAt,
      initial_leaf_count: initialLeafCount,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`茎を作れません: ${error?.message}`);
  return data.id as string;
}

// 地図上の点（プレビューの点・位置を直すモードの株の点）をマウスで (dx, dy) px だけドラッグする（1-3 / 2-3 で共通）。
// 点が画面内にあることを確かめてから、押した位置から 2 段階で動かして離す
export async function dragBy(page: Page, target: Locator, dx: number, dy: number) {
  await expect(target).toBeInViewport();
  const box = await target.boundingBox();
  if (!box) throw new Error("点の位置が取れません");
  const sx = box.x + box.width / 2;
  const sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + dx / 2, sy + dy / 2, { steps: 5 });
  await page.mouse.move(sx + dx, sy + dy, { steps: 10 });
  await page.mouse.up();
}

// 点の data-lat / data-lng
export async function readLatLng(el: Locator) {
  return {
    lat: Number(await el.getAttribute("data-lat")),
    lng: Number(await el.getAttribute("data-lng")),
  };
}
