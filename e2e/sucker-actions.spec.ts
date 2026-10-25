import type { Locator, Page } from "@playwright/test";
import { distanceM } from "../src/lib/geo";
import { nextMatCodes } from "../src/lib/mats/code";
import { ACTION_TIMEOUT, expect, supabaseAsA, test, waitForSynced } from "./helpers";
import { canvasCenter, CENTER, createField, createMat, createStem, dwarfNamwaId } from "./map-helpers";

// 2-2 吸芽の採用・芽かき・株分け。完了条件 1〜3 を 1 つずつ検証し、加えてオフラインの採用・株分けの株の地図と由来・
// 株コードの衝突からの再試行を確かめる。
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。テストごとにログインしない。
// 圃場の名前は E2E で始める（auth.setup.ts の掃除 e2e_cleanup_fields で、株分けで作った株も含めて圃場ごと消える。
// 株分けで作った株の mats.origin_stem_id は掃除関数が先に外す。別の E2E 圃場への株分けでも、両方の圃場が掃除の対象）。
// 圃場はワーカーごとに 1 つ作り、テストごとに株を分ける。株コードは株分けでも採番されるので、DB の最大番号の次にする。
// 注意: オフライン中は RSC の取得も失敗するので、オフラインにする前に株の詳細を開いておく（再読み込みもしない）。

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DB_NAME = "banana-field-notes";

let sharedField: Awaited<ReturnType<typeof createField>>;

test.beforeAll(async () => {
  sharedField = await createField("E2E吸芽操作");
});

async function nextCode(fieldId: string, fieldCode: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase.from("mats").select("code").eq("field_id", fieldId);
  if (error) throw new Error(`株コードを取得できません: ${error.message}`);
  return nextMatCodes(fieldCode, (data ?? []).map((m) => m.code), 1)[0];
}

async function newMat() {
  const code = await nextCode(sharedField.id, sharedField.code);
  const matId = await createMat(sharedField.id, code);
  return { code, matId };
}

// 親茎（栽培中）と吸芽を持つ株。吸芽は既存の補助関数 createStem（status=sucker）で作る（発生の記録 UI は 2-1 で検証済み）
async function matWithSucker(options: { suckers?: number; parentLeaves?: number; suckerStartedAt?: string } = {}) {
  const { code, matId } = await newMat();
  const parentId = await createStem(matId, { initialLeafCount: options.parentLeaves ?? 20 });
  const suckerIds: string[] = [];
  for (let i = 0; i < (options.suckers ?? 1); i++) {
    suckerIds.push(
      await createStem(matId, {
        generation: 2,
        parentStemId: parentId,
        status: "sucker",
        startedAt: options.suckerStartedAt ?? `2026-09-2${i}`,
        initialLeafCount: 0,
      }),
    );
  }
  return { code, matId, parentId, suckerIds };
}

const todayJst = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

async function stemRow(stemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("stems")
    .select("id, mat_id, generation, parent_stem_id, status, started_at, adopted_at, ended_at, initial_leaf_count, organization_id")
    .eq("id", stemId)
    .single();
  if (error) throw new Error(`茎を取得できません: ${error.message}`);
  return data!;
}

async function stemEvents(stemId: string, type: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("events")
    .select("id, type, target_type, target_id, payload, organization_id")
    .eq("target_type", "stem")
    .eq("target_id", stemId)
    .eq("type", type);
  if (error) throw new Error(`イベントを取得できません: ${error.message}`);
  return data!;
}

// クライアント側の遷移では前の画面の <main> が DOM に残るので、表示中の <main> に絞る
const view = (page: Page) => page.locator("main:visible");
const pendingCount = (page: Page) => page.getByTestId("sync-pending-count");
const stemItem = (page: Page, stemId: string) => view(page).locator(`[data-testid="stem-item"][data-stem-id="${stemId}"]`);

async function openMat(page: Page, matId: string, code: string) {
  await page.goto(`/mats/${matId}`);
  await expect(view(page).getByTestId("mat-code")).toHaveText(code);
  await expect(pendingCount(page)).toHaveText("0", { timeout: ACTION_TIMEOUT });
}

async function adoptOnScreen(page: Page, suckerId: string, leaves: string) {
  await stemItem(page, suckerId).getByTestId("sucker-adopt-open").click();
  const sheet = page.getByTestId("sucker-adopt-sheet");
  await expect(sheet).toBeVisible();
  await sheet.getByTestId("sucker-adopt-leaves").fill(leaves);
  await sheet.getByTestId("sucker-adopt-submit").click();
  await expect(sheet).toHaveCount(0);
  await expect(view(page).getByTestId("sucker-action-notice")).toHaveText("吸芽を採用しました");
}

// 株分けの画面の地図が使えるようになるまで待ち、地図を画面に入れる
async function transplantMap(page: Page): Promise<Locator> {
  const map = view(page).getByTestId("field-map");
  await expect(map).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(map).toHaveAttribute("data-map-ready", "true", { timeout: ACTION_TIMEOUT });
  await map.scrollIntoViewIfNeeded();
  return map;
}

// 地図の中心から dx px 右をタップして、選んだ位置（目印）を返す
async function pickPoint(page: Page, map: Locator, dx: number) {
  const c = await canvasCenter(map);
  await page.mouse.click(c.x + dx, c.y);
  const guide = page.getByTestId("guide-marker-single");
  await expect(guide).toHaveCount(1);
  return { lat: Number(await guide.getAttribute("data-lat")), lng: Number(await guide.getAttribute("data-lng")) };
}

function readOutbox(page: Page) {
  return page.evaluate(
    (dbName) =>
      new Promise<unknown[]>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const r = db.transaction("outbox").objectStore("outbox").getAll();
          r.onsuccess = () => {
            db.close();
            resolve(r.result);
          };
          r.onerror = () => reject(r.error);
        };
      }),
    DB_NAME,
  );
}

test("1. 採用すると栽培中の茎として一覧に出て、累計葉数 = 初期葉数。3 本目の後の採用は拒否される", async ({ page }) => {
  // 栽培中 2 本（親・子）と吸芽 2 本の株
  const { code, matId, parentId, suckerIds } = await matWithSucker({ suckers: 2 });
  const childId = await createStem(matId, { generation: 2, parentStemId: parentId, initialLeafCount: 6, startedAt: "2026-06-01" });
  const [first, second] = suckerIds;
  await openMat(page, matId, code);

  // 吸芽の行に「採用」「芽かき」「株分け」（各 44px 以上）
  const actions = stemItem(page, first).getByTestId("sucker-actions");
  await expect(actions).toBeVisible();
  for (const id of ["sucker-adopt-open", "sucker-remove-open", "sucker-transplant-open"]) {
    const box = await actions.getByTestId(id).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(stemItem(page, first).getByTestId("sucker-adopt-open")).toBeEnabled();

  // 初期葉数は必須
  await stemItem(page, first).getByTestId("sucker-adopt-open").click();
  const sheet = page.getByTestId("sucker-adopt-sheet");
  await sheet.getByTestId("sucker-adopt-submit").click();
  await expect(sheet.getByTestId("sucker-adopt-error")).toHaveText("初期葉数を入力してください");
  await sheet.getByTestId("sucker-adopt-cancel").click();
  await expect(sheet).toHaveCount(0);

  await adoptOnScreen(page, first, "8");

  // 栽培中の茎として出て、累計葉数 = 初期葉数 8。吸芽の操作は消える
  const adopted = stemItem(page, first);
  await expect(adopted).toHaveAttribute("data-status", "active");
  await expect(adopted.getByTestId("stem-status")).toHaveText("栽培中");
  await expect(adopted.getByTestId("stem-cumulative-leaves")).toHaveText("8");
  await expect(adopted.getByTestId("sucker-actions")).toHaveCount(0);
  await waitForSynced(page);

  // サーバー: status=active、adopted_at=今日、initial_leaf_count=8。sucker_adopted イベント（payload {initial_leaf_count}）
  expect(await stemRow(first)).toMatchObject({ status: "active", adopted_at: todayJst(), initial_leaf_count: 8, generation: 2, organization_id: ORG_A });
  const events = await stemEvents(first, "sucker_adopted");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ payload: { initial_leaf_count: 8 }, organization_id: ORG_A });

  // 栽培中が 3 本（親・子・採用した吸芽）になったので、もう 1 本の吸芽は採用できず理由が出る
  const other = stemItem(page, second);
  await expect(other.getByTestId("sucker-adopt-open")).toBeDisabled();
  await expect(other.getByTestId("sucker-adopt-blocked")).toHaveText(
    "この株には栽培中の茎が 3 本あるため採用できません。先に他の吸芽を芽かきするか株分けしてください",
  );
  // 芽かき・株分けはできる
  await expect(other.getByTestId("sucker-remove-open")).toBeEnabled();

  // 再読み込み後も同じ（サーバーの状態）。採用した茎は栽培中で累計 8
  await page.reload();
  await expect(stemItem(page, first).getByTestId("stem-status")).toHaveText("栽培中");
  await expect(stemItem(page, first).getByTestId("stem-cumulative-leaves")).toHaveText("8");
  await expect(stemItem(page, second).getByTestId("sucker-adopt-open")).toBeDisabled();

  // DB のトリガーが正本: 画面を通さず RPC を呼んでも拒否され、日本語の理由が返る。吸芽のまま・イベントもできない
  const supabase = await supabaseAsA();
  const rejectedId = crypto.randomUUID();
  const { error } = await supabase.rpc("adopt_sucker", {
    p_event_id: rejectedId,
    p_stem_id: second,
    p_occurred_at: new Date().toISOString(),
    p_initial_leaf_count: 5,
  });
  expect(error?.message).toBe("この株には栽培中の茎が 3 本あるため採用できません。先に他の吸芽を芽かきするか株分けしてください");
  expect((await stemRow(second)).status).toBe("sucker");
  expect(await stemEvents(second, "sucker_adopted")).toHaveLength(0);
  expect((await stemRow(childId)).status).toBe("active");

  // 採用した茎の画面では記録できる（栽培中）
  await stemItem(page, first).getByTestId("stem-link").click();
  await expect(page).toHaveURL(`/stems/${first}`);
  await expect(view(page).getByTestId("stem-status")).toHaveText("栽培中");
  await expect(view(page).getByTestId("leaves-new-1")).toBeVisible();
});

test("2. 芽かきした吸芽は「芽かき」として表示され、記録ボタンが出ない", async ({ page }) => {
  const { code, matId, suckerIds } = await matWithSucker();
  const [suckerId] = suckerIds;
  await openMat(page, matId, code);

  // 確認ダイアログ。「やめる」なら何も起きない
  await stemItem(page, suckerId).getByTestId("sucker-remove-open").click();
  const dialog = page.getByTestId("sucker-remove-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("芽かきしますか？");
  await dialog.getByTestId("sucker-remove-cancel").click();
  await expect(dialog).toHaveCount(0);
  await expect(stemItem(page, suckerId)).toHaveAttribute("data-status", "sucker");

  await stemItem(page, suckerId).getByTestId("sucker-remove-open").click();
  await page.getByTestId("sucker-remove-dialog").getByTestId("sucker-remove-submit").click();
  await expect(page.getByTestId("sucker-remove-dialog")).toHaveCount(0);
  await expect(view(page).getByTestId("sucker-action-notice")).toHaveText("吸芽を芽かきしました");

  // 「芽かき」と表示され、採用・芽かき・株分けのボタンは出ない
  const removed = stemItem(page, suckerId);
  await expect(removed).toHaveAttribute("data-status", "removed");
  await expect(removed.getByTestId("stem-status")).toHaveText("芽かき");
  await expect(removed.getByTestId("sucker-actions")).toHaveCount(0);
  await waitForSynced(page);

  // サーバー: status=removed、ended_at=今日。sucker_removed イベント
  expect(await stemRow(suckerId)).toMatchObject({ status: "removed", ended_at: todayJst() });
  const events = await stemEvents(suckerId, "sucker_removed");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ payload: {}, organization_id: ORG_A });

  // 再読み込み後も芽かき。行は茎の画面へのリンクだけ
  await page.reload();
  await expect(stemItem(page, suckerId).getByTestId("stem-status")).toHaveText("芽かき");
  await expect(stemItem(page, suckerId).getByTestId("sucker-actions")).toHaveCount(0);
  await stemItem(page, suckerId).getByTestId("stem-link").click();

  // 茎の画面: 状態は芽かき。記録ボタン（葉数・イベント）は出ず、履歴だけ（芽かきの記録がある）
  await expect(page).toHaveURL(`/stems/${suckerId}`);
  await expect(view(page).getByTestId("stem-status")).toHaveText("芽かき");
  await expect(view(page).getByTestId("record-closed")).toHaveText("この茎は芽かきのため記録できません。履歴だけ見られます");
  await expect(view(page).getByTestId("leaves-new-1")).toHaveCount(0);
  await expect(view(page).getByTestId("event-buttons")).toHaveCount(0);
  const item = view(page).locator('[data-testid="history-item"][data-type="sucker_removed"]');
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("history-label")).toHaveText("芽かき");

  // 吸芽でなくなった茎は RPC でも芽かき・採用できない（日本語の理由）
  const supabase = await supabaseAsA();
  const { error } = await supabase.rpc("remove_sucker", {
    p_event_id: crypto.randomUUID(),
    p_stem_id: suckerId,
    p_occurred_at: new Date().toISOString(),
    p_note: null,
  });
  expect(error?.message).toBe("芽かきは吸芽の茎にだけできます（この茎は芽かき）");
});

test("3. 株分けすると転出先に新しい株ができ、由来をたどれる。元の吸芽は「株分け」状態になる（地図にも出る）", async ({ page }) => {
  const { code, matId, suckerIds } = await matWithSucker({ suckerStartedAt: "2026-09-18" });
  const [suckerId] = suckerIds;
  await openMat(page, matId, code);

  await stemItem(page, suckerId).getByTestId("sucker-transplant-open").click();
  await expect(page).toHaveURL(`/stems/${suckerId}/transplant`);
  await expect(view(page).getByTestId("transplant-source")).toContainText(`株 ${code} の子（第 2 世代）の吸芽`);
  // 転出先の既定は同じ圃場。新しい株のコードは圃場記号 + 既存の最大番号の次
  await expect(view(page).getByTestId("transplant-field")).toHaveValue(sharedField.id);
  const expectedCode = await nextCode(sharedField.id, sharedField.code);
  await expect(view(page).getByTestId("transplant-code")).toHaveText(expectedCode);

  const map = await transplantMap(page);
  // 位置を選ばずに確定すると理由が出る
  await view(page).getByTestId("transplant-leaves").fill("5");
  await view(page).getByTestId("transplant-submit").click();
  await expect(view(page).getByTestId("transplant-error")).toHaveText("転出先の位置を地図でタップしてください");
  // 既存の株（地図の中心）の上は空いていないので断る
  const c = await canvasCenter(map);
  await page.mouse.click(c.x + 4, c.y);
  await expect(view(page).getByTestId("transplant-error")).toContainText("に近すぎます。空いている位置をタップしてください");
  await expect(page.getByTestId("guide-marker-single")).toHaveCount(0);
  // 空いている位置をタップ
  const tapped = await pickPoint(page, map, 90);
  expect(distanceM(tapped, CENTER)).toBeGreaterThan(1);
  await expect(view(page).getByTestId("transplant-error")).toHaveCount(0);

  await view(page).getByTestId("transplant-submit").click();

  // 完了したら新しい株の詳細へ
  await expect(page).not.toHaveURL(/transplant/, { timeout: ACTION_TIMEOUT });
  await expect(page).toHaveURL(/\/mats\/[0-9a-f-]{36}$/);
  const newMatId = page.url().split("/").at(-1)!;
  await expect(view(page).getByTestId("mat-code")).toHaveText(expectedCode);
  await expect(view(page).getByTestId("mat-origin-type")).toHaveText("株分け");
  await expect(view(page).getByTestId("mat-planted-at")).toHaveText(todayJst());
  await expect(view(page).getByTestId("mat-cultivar")).toHaveText("ドワーフナムワ");
  // 由来: 元の株コード（茎の世代）のリンク
  const originLink = view(page).getByTestId("mat-origin-link");
  await expect(originLink).toHaveText(`株 ${code}（子）から株分け`);
  await expect(originLink).toHaveAttribute("href", `/mats/${matId}`);
  // 茎は generation 1 の 1 本（栽培中、累計葉数 = 初期葉数 5）
  const newStems = view(page).getByTestId("stem-item");
  await expect(newStems).toHaveCount(1);
  await expect(newStems.first()).toHaveAttribute("data-generation", "1");
  await expect(newStems.first().getByTestId("stem-status")).toHaveText("栽培中");
  await expect(newStems.first().getByTestId("stem-cumulative-leaves")).toHaveText("5");

  // サーバー: 新しい株（転出先・位置・品種は元と同じ・由来）、その茎（started_at は吸芽を引き継ぐ）、吸芽は transplanted
  const supabase = await supabaseAsA();
  const { data: newMat } = await supabase
    .from("mats")
    .select("id, field_id, code, cultivar_id, lat, lng, planted_at, origin_type, origin_stem_id, status, organization_id")
    .eq("id", newMatId)
    .single();
  expect(newMat).toMatchObject({
    field_id: sharedField.id,
    code: expectedCode,
    cultivar_id: await dwarfNamwaId(),
    planted_at: todayJst(),
    origin_type: "sucker_transplant",
    origin_stem_id: suckerId,
    status: "active",
    organization_id: ORG_A,
  });
  expect(distanceM({ lat: newMat!.lat, lng: newMat!.lng }, tapped)).toBeLessThan(0.01);
  const { data: newStemRows } = await supabase
    .from("stems")
    .select("id, generation, parent_stem_id, status, started_at, adopted_at, initial_leaf_count, organization_id")
    .eq("mat_id", newMatId);
  expect(newStemRows).toEqual([
    expect.objectContaining({
      generation: 1,
      parent_stem_id: null,
      status: "active",
      started_at: "2026-09-18",
      adopted_at: todayJst(),
      initial_leaf_count: 5,
      organization_id: ORG_A,
    }),
  ]);
  expect(await stemRow(suckerId)).toMatchObject({ status: "transplanted", ended_at: todayJst(), mat_id: matId });
  const events = await stemEvents(suckerId, "sucker_transplanted");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ payload: { to_mat_id: newMatId }, organization_id: ORG_A });

  // 由来のリンクで元の株へ。元の吸芽は「株分け」状態で、操作のボタンは出ない
  await originLink.click();
  await expect(page).toHaveURL(`/mats/${matId}`);
  await expect(stemItem(page, suckerId).getByTestId("stem-status")).toHaveText("株分け");
  await expect(stemItem(page, suckerId)).toHaveAttribute("data-status", "transplanted");
  await expect(stemItem(page, suckerId).getByTestId("sucker-actions")).toHaveCount(0);
  // 元の吸芽の画面: 記録ボタンは出ず、履歴に株分け
  await stemItem(page, suckerId).getByTestId("stem-link").click();
  await expect(page).toHaveURL(`/stems/${suckerId}`);
  await expect(view(page).getByTestId("record-closed")).toBeVisible();
  await expect(view(page).getByTestId("leaves-new-1")).toHaveCount(0);
  await expect(view(page).locator('[data-testid="history-item"][data-type="sucker_transplanted"]')).toHaveCount(1);

  // 株分けで作られた株は地図に出る。タップで新しい株の詳細 → 由来のリンクで元の株へ
  await page.goto(`/fields/${sharedField.id}/map`);
  await expect(page.getByTestId("field-map")).toHaveAttribute("data-map-ready", "true", { timeout: ACTION_TIMEOUT });
  const marker = page.locator(`[data-testid="mat-marker"][data-code="${expectedCode}"]`);
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute("data-mat-id", newMatId);
  await marker.click();
  await expect(page).toHaveURL(`/mats/${newMatId}`, { timeout: ACTION_TIMEOUT });
  await view(page).getByTestId("mat-origin-link").click();
  await expect(page).toHaveURL(`/mats/${matId}`);
  await expect(view(page).getByTestId("mat-code")).toHaveText(code);
});

test("3b. 別の圃場へ株分けできる（転出先の圃場を選ぶと、その圃場の地図と採番になる）", async ({ page }) => {
  const dest = await createField("E2E吸芽分け先");
  const { code, matId, suckerIds } = await matWithSucker();
  const [suckerId] = suckerIds;
  await page.goto(`/stems/${suckerId}/transplant`);
  await expect(view(page).getByTestId("transplant-field")).toHaveValue(sharedField.id);

  await view(page).getByTestId("transplant-field").selectOption(dest.id);
  await expect(page).toHaveURL(`/stems/${suckerId}/transplant?field=${dest.id}`, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("transplant-code")).toHaveText(`${dest.code}-001`);
  const map = await transplantMap(page);
  await expect(page.getByTestId("mat-marker")).toHaveCount(0);
  await pickPoint(page, map, 0);
  await view(page).getByTestId("transplant-leaves").fill("4");
  await view(page).getByTestId("transplant-submit").click();

  await expect(page).not.toHaveURL(/transplant/, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("mat-code")).toHaveText(`${dest.code}-001`);
  await expect(view(page).getByTestId("mat-origin-link")).toHaveText(`株 ${code}（子）から株分け`);
  const newMatId = page.url().split("/").at(-1)!;
  const supabase = await supabaseAsA();
  const { data } = await supabase.from("mats").select("field_id, origin_stem_id").eq("id", newMatId).single();
  expect(data).toEqual({ field_id: dest.id, origin_stem_id: suckerId });
  expect((await stemRow(suckerId)).status).toBe("transplanted");

  // 転出先の圃場の地図に出る
  await page.goto(`/fields/${dest.id}/map`);
  await expect(page.getByTestId("field-map")).toHaveAttribute("data-map-ready", "true", { timeout: ACTION_TIMEOUT });
  await expect(page.locator(`[data-testid="mat-marker"][data-code="${dest.code}-001"]`)).toHaveCount(1);
  // 元の株は元の圃場のまま
  await page.goto(`/mats/${matId}`);
  await expect(stemItem(page, suckerId).getByTestId("stem-status")).toHaveText("株分け");
});

test("4. 採用はオフラインで記録でき、オンラインで同期される（再送で二重にならない）。株分けはオフラインでは無効", async ({ page, context }) => {
  const { code, matId, suckerIds } = await matWithSucker({ suckers: 2 });
  const [suckerId, otherId] = suckerIds;
  await openMat(page, matId, code);

  await context.setOffline(true);
  // オフラインでは株分けのボタンが無効になり、理由が出る
  await expect(stemItem(page, suckerId).getByTestId("sucker-transplant-open")).toBeDisabled();
  await expect(stemItem(page, suckerId).getByTestId("sucker-transplant-offline")).toHaveText(
    "株分けは新しい株を作るため、オンラインのときだけできます",
  );

  await adoptOnScreen(page, suckerId, "7");
  // 未同期 1。見かけは栽培中・累計 7
  await expect(pendingCount(page)).toHaveText("1", { timeout: ACTION_TIMEOUT });
  await expect(stemItem(page, suckerId)).toHaveAttribute("data-status", "active");
  await expect(stemItem(page, suckerId).getByTestId("stem-cumulative-leaves")).toHaveText("7");
  await expect(stemItem(page, otherId).getByTestId("sucker-transplant-open")).toBeDisabled();
  // サーバーにはまだ無い
  expect((await stemRow(suckerId)).status).toBe("sucker");
  expect(await stemEvents(suckerId, "sucker_adopted")).toHaveLength(0);

  const outbox = await readOutbox(page);
  expect(outbox).toHaveLength(1);
  const saved = outbox[0] as { id: string; stem_id: string; payload: { method: string; payload: { initial_leaf_count: number } } };
  expect(saved).toMatchObject({ stem_id: suckerId, payload: { method: "adopt_sucker", payload: { initial_leaf_count: 7 } } });

  // オンラインに戻す → 同期。サーバーに反映され、株分けも押せるようになる
  await context.setOffline(false);
  await expect(pendingCount(page)).toHaveText("0", { timeout: ACTION_TIMEOUT });
  expect(await stemRow(suckerId)).toMatchObject({ status: "active", initial_leaf_count: 7, adopted_at: todayJst() });
  const events = await stemEvents(suckerId, "sucker_adopted");
  expect(events).toHaveLength(1);
  expect(events[0].id).toBe(saved.id);
  await expect(stemItem(page, suckerId).getByTestId("stem-status")).toHaveText("栽培中");
  await expect(stemItem(page, otherId).getByTestId("sucker-transplant-open")).toBeEnabled();
  await expect(stemItem(page, otherId).getByTestId("sucker-transplant-offline")).toHaveCount(0);

  // 再送: 同じ outbox 項目をもう一度積んで同期させても、イベントは増えず要確認にもならない
  await page.evaluate(
    ({ dbName, item }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("outbox", "readwrite");
          tx.objectStore("outbox").put(item);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    { dbName: DB_NAME, item: outbox[0] },
  );
  expect(await readOutbox(page)).toHaveLength(1);
  await page.getByTestId("sync-indicator").click();
  await page.getByTestId("sync-panel").getByTestId("sync-now").click();
  await expect.poll(async () => (await readOutbox(page)).length, { timeout: ACTION_TIMEOUT }).toBe(0);
  await expect(page.getByTestId("sync-attention-count")).toHaveCount(0);
  expect(await stemEvents(suckerId, "sucker_adopted")).toHaveLength(1);

  // RPC を直接 2 回呼んでも同じ（p_event_id で冪等。初期葉数も変わらない）
  const supabase = await supabaseAsA();
  for (let i = 0; i < 2; i++) {
    const r = await supabase.rpc("adopt_sucker", {
      p_event_id: saved.id,
      p_stem_id: suckerId,
      p_occurred_at: new Date().toISOString(),
      p_initial_leaf_count: 99,
    });
    expect(r.error).toBeNull();
    expect(r.data).toBe(saved.id);
  }
  expect((await stemRow(suckerId)).initial_leaf_count).toBe(7);
  expect(await stemEvents(suckerId, "sucker_adopted")).toHaveLength(1);
});

test("5. 株分けで株コードが衝突したら、採番し直して再試行できる", async ({ page }) => {
  const { matId, suckerIds } = await matWithSucker();
  const [suckerId] = suckerIds;
  await page.goto(`/stems/${suckerId}/transplant`);
  const proposed = await nextCode(sharedField.id, sharedField.code);
  await expect(view(page).getByTestId("transplant-code")).toHaveText(proposed);

  // 画面を開いた後に、別の経路で同じコードの株ができる
  await createMat(sharedField.id, proposed);
  const map = await transplantMap(page);
  await pickPoint(page, map, -90);
  await view(page).getByTestId("transplant-leaves").fill("3");
  await view(page).getByTestId("transplant-submit").click();

  // 衝突: 理由と採番し直したコードが出て、再試行のボタンになる。何も保存されていない
  const retryCode = nextMatCodes(sharedField.code, [proposed], 1)[0];
  await expect(view(page).getByTestId("transplant-error")).toHaveText(
    `株コード ${proposed} は他の記録で使われていました。新しいコード ${retryCode} で再試行してください`,
    { timeout: ACTION_TIMEOUT },
  );
  await expect(view(page).getByTestId("transplant-code")).toHaveText(retryCode);
  await expect(view(page).getByTestId("transplant-submit")).toHaveText(`${retryCode} で再試行`);
  expect((await stemRow(suckerId)).status).toBe("sucker");
  expect(await stemEvents(suckerId, "sucker_transplanted")).toHaveLength(0);

  await view(page).getByTestId("transplant-submit").click();
  await expect(page).not.toHaveURL(/transplant/, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("mat-code")).toHaveText(retryCode);
  await expect(view(page).getByTestId("mat-origin-link")).toHaveAttribute("href", `/mats/${matId}`);
  expect((await stemRow(suckerId)).status).toBe("transplanted");
  expect(await stemEvents(suckerId, "sucker_transplanted")).toHaveLength(1);
});
