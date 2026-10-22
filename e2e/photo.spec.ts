import path from "node:path";
import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, supabaseAsA, test } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";

// 1-7 写真の撮影と保存。完了条件 1〜2 を 1 つずつ検証する。
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。テストごとにログインしない。
// テストが作る圃場の名前は E2E で始める（setup の掃除が photos の行と Storage のオブジェクトを消す）。
// 画像は e2e/fixtures/stem-side.jpg（320x240、EXIF: DateTimeOriginal=2026:10:20 09:15:30、GPS 26°30'N 127°54'E）。
// EXIF の日時はタイムゾーンを持たないので、ブラウザのタイムゾーンを Asia/Tokyo に固定して期待値を決める。

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FIXTURE = path.resolve(__dirname, "fixtures", "stem-side.jpg");
const EXIF_TAKEN_AT_JST = "2026-10-20T00:15:30.000Z"; // 2026:10:20 09:15:30 (+09:00)

test.use({ timezoneId: "Asia/Tokyo" });

let sharedField: Awaited<ReturnType<typeof createField>>;
let matSeq = 0;

test.beforeAll(async () => {
  sharedField = await createField("E2E写真");
});

async function setupStem() {
  const field = sharedField;
  matSeq += 1;
  const code = `${field.code}-${String(matSeq).padStart(3, "0")}`;
  const matId = await createMat(field.id, code);
  const stemId = await createStem(matId, { initialLeafCount: 3 });
  return { field, code, matId, stemId };
}

async function photoRows(stemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("photos")
    .select("id, storage_path, taken_at, taken_by, lat, lng, target_type, target_id, kind, upload_status, organization_id, observation_id, event_id")
    .eq("target_type", "stem")
    .eq("target_id", stemId)
    .order("taken_at");
  if (error) throw new Error(`写真を取得できません: ${error.message}`);
  return data!;
}

async function profileIdA() {
  const supabase = await supabaseAsA();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("A のユーザーが取れません");
  return user.id;
}

// クライアント側の遷移では前の画面の <main> が DOM に残るので、表示中の <main> に絞る
const view = (page: Page) => page.locator("main:visible");

async function openStem(page: Page, stemId: string, matCode: string) {
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(matCode);
}

test("1. 画像を選ぶと Storage に保存され、茎の履歴にサムネイルが出る", async ({ page }) => {
  const { code, stemId } = await setupStem();
  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("history-empty")).toHaveText("記録なし");

  // 撮影（capture 付きの file input）。種類の既定は「横から」
  const input = view(page).getByTestId("photo-input");
  await expect(input).toHaveAttribute("accept", "image/*");
  await expect(input).toHaveAttribute("capture", "environment");
  await expect(view(page).getByTestId("photo-kind")).toHaveValue("side");
  await input.setInputFiles(FIXTURE);

  // 履歴に写真の項目が 1 つ出て、サムネイル画像が実際に読み込まれる（署名付き URL が有効）
  const item = view(page).getByTestId("history-item");
  await expect(item).toHaveCount(1, { timeout: ACTION_TIMEOUT });
  await expect(item.first()).toHaveAttribute("data-kind", "photo");
  await expect(item.first()).toHaveAttribute("data-type", "side");
  await expect(item.first().getByTestId("history-label")).toHaveText("写真");
  await expect(item.first().getByTestId("history-value")).toHaveText("横から");
  await expect(view(page).getByTestId("photo-error")).toHaveCount(0);

  const thumb = item.first().getByTestId("history-photo-thumb");
  await expect(thumb).toBeVisible();
  await expect
    .poll(() => thumb.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth), {
      timeout: ACTION_TIMEOUT,
    })
    .toBeGreaterThan(0);
  const thumbSrc = await thumb.getAttribute("src");
  expect(thumbSrc).toMatch(/\/storage\/v1\/object\/sign\/photos\//);

  // Storage に storage_path のオブジェクトがある（list でファイル名が見える）
  const rows = await photoRows(stemId);
  expect(rows).toHaveLength(1);
  const storagePath = rows[0].storage_path as string;
  expect(storagePath).toBe(`${ORG_A}/stem/${stemId}/${rows[0].id}.jpg`);
  const supabase = await supabaseAsA();
  const folder = storagePath.slice(0, storagePath.lastIndexOf("/"));
  const { data: objects, error: listError } = await supabase.storage.from("photos").list(folder);
  expect(listError).toBeNull();
  expect(objects?.map((o) => o.name)).toContain(`${rows[0].id}.jpg`);
  // 署名付き URL も取れる（RLS で自組織のオブジェクトを読める）
  const { data: signed, error: signError } = await supabase.storage.from("photos").createSignedUrl(storagePath, 60);
  expect(signError).toBeNull();
  expect(signed?.signedUrl).toBeTruthy();

  // サムネイルをタップすると原寸の表示が開き、閉じられる
  await item.first().getByTestId("history-photo-open").click();
  const viewer = page.getByTestId("photo-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.getByTestId("photo-viewer-image")).toHaveAttribute("src", thumbSrc!);
  await viewer.getByTestId("photo-viewer-close").click();
  await expect(viewer).toHaveCount(0);

  // 再読み込み後も履歴にサムネイルが出る（署名付き URL はサーバーで作り直される）
  await page.reload();
  await expect(view(page).getByTestId("history-item")).toHaveCount(1);
  const thumb2 = view(page).getByTestId("history-photo-thumb");
  await expect
    .poll(() => thumb2.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth), {
      timeout: ACTION_TIMEOUT,
    })
    .toBeGreaterThan(0);

  // 履歴画面（画面 8）にも同じ写真が出る
  await view(page).getByTestId("stem-history-link").click();
  await expect(page).toHaveURL(`/stems/${stemId}/history`, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("history-item")).toHaveCount(1);
  await expect(view(page).getByTestId("history-photo-thumb")).toBeVisible();
});

test("2. photos の行に target_id と taken_at（EXIF の撮影日時）が入っている", async ({ page }) => {
  const { code, stemId } = await setupStem();
  await openStem(page, stemId, code);

  // 種類を「蕾」にして撮影
  await view(page).getByTestId("photo-kind").selectOption("bud");
  await view(page).getByTestId("photo-input").setInputFiles(FIXTURE);
  const item = view(page).getByTestId("history-item");
  await expect(item).toHaveCount(1, { timeout: ACTION_TIMEOUT });
  await expect(item.first()).toHaveAttribute("data-type", "bud");
  await expect(item.first().getByTestId("history-value")).toHaveText("蕾");

  // DB: target_type=stem, target_id=茎, taken_at=EXIF の DateTimeOriginal（端末のローカル時刻 = JST として解釈）、
  // taken_by=A の profile、kind=bud、upload_status=uploaded、lat/lng=EXIF の GPS。organization_id はトリガーがコピー
  const rows = await photoRows(stemId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    target_type: "stem",
    target_id: stemId,
    taken_by: await profileIdA(),
    kind: "bud",
    upload_status: "uploaded",
    organization_id: ORG_A,
    observation_id: null,
    event_id: null,
  });
  expect(new Date(rows[0].taken_at).toISOString()).toBe(EXIF_TAKEN_AT_JST);
  expect(rows[0].lat).toBeCloseTo(26.5, 6);
  expect(rows[0].lng).toBeCloseTo(127.9, 6);
  expect(rows[0].storage_path).toBe(`${ORG_A}/stem/${stemId}/${rows[0].id}.jpg`);

  // 履歴の日時表示も EXIF の撮影日時（現在時刻ではない）
  await expect(item.first().getByTestId("history-at")).toHaveAttribute("datetime", EXIF_TAKEN_AT_JST);
  await expect(item.first().getByTestId("history-at")).toHaveText("2026/10/20 09:15");
});

test("2b. EXIF のない画像は taken_at が現在時刻になり、同じ茎に 2 枚目として追記される", async ({ page }) => {
  const { code, stemId } = await setupStem();
  await openStem(page, stemId, code);

  // 1 枚目: EXIF あり
  await view(page).getByTestId("photo-input").setInputFiles(FIXTURE);
  await expect(view(page).getByTestId("history-item")).toHaveCount(1, { timeout: ACTION_TIMEOUT });

  // 2 枚目: EXIF なしの PNG（ブラウザで描いて JPEG に変換されて送られる）
  const before = Date.now();
  await view(page).getByTestId("photo-input").setInputFiles({
    name: "no-exif.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DwHwyBBAMDAC7mBfU/5NoeAAAAAElFTkSuQmCC",
      "base64",
    ),
  });
  const items = view(page).getByTestId("history-item");
  await expect(items).toHaveCount(2, { timeout: ACTION_TIMEOUT });

  const rows = await photoRows(stemId);
  expect(rows).toHaveLength(2);
  // 撮影日時順: EXIF（2026-10-20）→ 現在時刻
  expect(new Date(rows[0].taken_at).toISOString()).toBe(EXIF_TAKEN_AT_JST);
  const takenAt = new Date(rows[1].taken_at).getTime();
  expect(takenAt).toBeGreaterThanOrEqual(before - 1_000);
  expect(takenAt).toBeLessThanOrEqual(Date.now() + 1_000);
  expect(rows[1].lat).toBeNull();
  expect(rows[1].lng).toBeNull();
  expect(rows.map((r) => r.target_id)).toEqual([stemId, stemId]);

  // 履歴は新しい順（現在時刻の写真が上）。両方のサムネイルが読み込まれる
  const datetimes = await items.locator("[data-testid=history-at]").evaluateAll((els) => els.map((e) => e.getAttribute("datetime")));
  expect(datetimes[1]).toBe(EXIF_TAKEN_AT_JST);
  expect(new Date(datetimes[0]!).getTime()).toBe(takenAt);
  for (const img of await view(page).getByTestId("history-photo-thumb").all()) {
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: ACTION_TIMEOUT }).toBeGreaterThan(0);
  }

  // 写真を編集・削除する UI はない（追記のみ）
  await expect(view(page).getByRole("button", { name: /削除|編集/ })).toHaveCount(0);
});
