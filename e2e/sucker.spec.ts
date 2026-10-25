import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, supabaseAsA, test, waitForSynced } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";

// 2-1 吸芽の発生の記録。完了条件 1〜3 を 1 つずつ検証する。
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。テストごとにログインしない。
// 圃場の名前は E2E で始める（auth.setup.ts の掃除 e2e_cleanup_fields で、吸芽の茎も含めて株単位で消える）。
// 観測・イベントを持つ茎は消せないので、圃場はワーカーごとに 1 つだけ作り、テストごとに株を分ける。
// 注意: オフライン中は RSC の取得も失敗するので、オフラインにする前に株の詳細を開いておく（再読み込みもしない）。

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DB_NAME = "banana-field-notes";

let sharedField: Awaited<ReturnType<typeof createField>>;
let matSeq = 0;

test.beforeAll(async () => {
  sharedField = await createField("E2E吸芽");
});

async function newMat() {
  matSeq += 1;
  const code = `${sharedField.code}-${String(matSeq).padStart(3, "0")}`;
  const matId = await createMat(sharedField.id, code);
  return { code, matId };
}

const todayJst = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

async function addLeavesNew(stemId: string, value: number, observedAt: string) {
  const supabase = await supabaseAsA();
  const { error } = await supabase.from("observations").insert({ stem_id: stemId, type: "leaves_new", value, observed_at: observedAt });
  if (error) throw new Error(`観測を作れません: ${error.message}`);
}

async function stemRows(matId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("stems")
    .select("id, generation, parent_stem_id, status, started_at, initial_leaf_count, organization_id")
    .eq("mat_id", matId)
    .order("generation");
  if (error) throw new Error(`茎を取得できません: ${error.message}`);
  return data!;
}

async function suckerEvents(parentStemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("events")
    .select("id, type, target_type, target_id, payload, organization_id")
    .eq("target_type", "stem")
    .eq("target_id", parentStemId)
    .eq("type", "sucker_emerged");
  if (error) throw new Error(`イベントを取得できません: ${error.message}`);
  return data!;
}

// クライアント側の遷移では前の画面の <main> が DOM に残るので、表示中の <main> に絞る
const view = (page: Page) => page.locator("main:visible");
const pendingCount = (page: Page) => page.getByTestId("sync-pending-count");

async function openMat(page: Page, matId: string, code: string) {
  await page.goto(`/mats/${matId}`);
  await expect(view(page).getByTestId("mat-code")).toHaveText(code);
  // 起動時の同期が終わり、未同期 0 の状態から始める
  await expect(pendingCount(page)).toHaveText("0", { timeout: ACTION_TIMEOUT });
}

// 「吸芽が出た」→ 方向・種類を選んで記録する（親茎・確認日は既定のまま）
async function recordSucker(page: Page, direction: string, type: "sword" | "water") {
  await view(page).getByTestId("sucker-open").click();
  const sheet = page.getByTestId("sucker-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("sucker-date")).toHaveValue(todayJst());
  await sheet.getByTestId(`sucker-direction-${direction}`).click();
  await expect(sheet.getByTestId(`sucker-direction-${direction}`)).toHaveAttribute("aria-pressed", "true");
  await sheet.getByTestId(`sucker-type-${type}`).click();
  await expect(sheet.getByTestId(`sucker-type-${type}`)).toHaveAttribute("aria-pressed", "true");
  await sheet.getByTestId("sucker-submit").click();
  await expect(sheet).toHaveCount(0);
  await expect(view(page).getByTestId("sucker-notice")).toHaveText("吸芽を記録しました");
}

// 端末の outbox の中身（Dexie を通さず IndexedDB を直接読む）
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

const suckerItems = (page: Page) => view(page).locator('[data-testid="stem-item"][data-status="sucker"]');

test("1. 吸芽を記録すると株の詳細に「吸芽」として表示され、親茎の履歴に方向・種類・その時点の親の累計葉数が出る", async ({ page }) => {
  const { code, matId } = await newMat();
  // 親茎: 初期葉数 15 + 新葉 3（サーバーの観測）= 累計 18
  const parentId = await createStem(matId, { initialLeafCount: 15 });
  await addLeavesNew(parentId, 3, "2026-10-01T01:00:00Z");
  await openMat(page, matId, code);
  await expect(view(page).getByTestId("stem-item")).toHaveCount(1);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("18");

  // 方向のボタンは 3×3（中央は空き）に 8 個。各 44px 以上
  await view(page).getByTestId("sucker-open").click();
  const sheet = page.getByTestId("sucker-sheet");
  await expect(sheet.getByTestId("sucker-parent-fixed")).toContainText("親（第 1 世代・栽培中）");
  const dirs = sheet.locator('[data-testid^="sucker-direction-"]');
  await expect(dirs).toHaveCount(8);
  for (const box of await dirs.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ w: r.width, h: r.height })))) {
    expect(box.w).toBeGreaterThanOrEqual(44);
    expect(box.h).toBeGreaterThanOrEqual(44);
  }
  // 未選択のまま記録すると理由が出る
  await sheet.getByTestId("sucker-submit").click();
  await expect(sheet.getByTestId("sucker-error")).toHaveText("方向を選んでください");
  await sheet.getByTestId("sucker-cancel").click();
  await expect(sheet).toHaveCount(0);

  await recordSucker(page, "NE", "sword");

  // 株の詳細の茎一覧に「吸芽」として出る（第 2 世代 = 子）
  await expect(suckerItems(page)).toHaveCount(1);
  await expect(suckerItems(page).first()).toHaveAttribute("data-generation", "2");
  await expect(suckerItems(page).first().getByTestId("stem-status")).toHaveText("吸芽");
  await expect(suckerItems(page).first()).toContainText("子");
  await waitForSynced(page);

  // サーバー: 吸芽の茎（status=sucker、親+1、親茎、started_at=今日、初期葉数 0、organization_id はトリガー）
  const stems = await stemRows(matId);
  expect(stems).toHaveLength(2);
  const sucker = stems.find((s) => s.status === "sucker")!;
  expect(sucker).toMatchObject({ generation: 2, parent_stem_id: parentId, started_at: todayJst(), initial_leaf_count: 0, organization_id: ORG_A });
  // 親茎のイベント（payload は data-model の表どおり。累計はその時点の 18、前回訪問日は株の直近の観測日）
  const events = await suckerEvents(parentId);
  expect(events).toHaveLength(1);
  expect(events[0].payload).toEqual({
    sucker_stem_id: sucker.id,
    parent_cumulative_leaves: 18,
    earliest_at: "2026-10-01",
    direction: "NE",
    sucker_type: "sword",
  });
  expect(events[0].organization_id).toBe(ORG_A);

  // 再読み込みしても吸芽のまま（未同期の印なし）。吸芽の行は茎の画面へのリンク
  await page.reload();
  await expect(suckerItems(page)).toHaveCount(1);
  await expect(suckerItems(page).first()).not.toHaveAttribute("data-pending", "true");
  await expect(suckerItems(page).first().getByTestId("stem-link")).toHaveAttribute("href", `/stems/${sucker.id}`);

  // 吸芽の茎の画面: 状態は吸芽。採用前なので累計葉数は出さない
  await page.goto(`/stems/${sucker.id}`);
  await expect(view(page).getByTestId("stem-status")).toHaveText("吸芽");
  await expect(view(page).getByTestId("record-closed")).toBeVisible();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveCount(0);

  // 親茎の履歴に「吸芽 北東・剣葉・親の累計 18 枚」
  await page.goto(`/stems/${parentId}`);
  const item = view(page).locator('[data-testid="history-item"][data-type="sucker_emerged"]');
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("history-label")).toHaveText("吸芽");
  await expect(item.getByTestId("history-value")).toHaveText("北東・剣葉・親の累計 18 枚");
});

test("1c. 同じ日に新葉を記録してから吸芽を記録すると、前回訪問日の既定値は確認日より前の観測日（なければ空）", async ({ page }) => {
  const { code, matId } = await newMat();
  const parentId = await createStem(matId, { initialLeafCount: 10 });
  await addLeavesNew(parentId, 2, "2026-10-01T01:00:00Z"); // 前回の巡回（JST 10-01）

  // 今日の巡回: 茎の画面で新葉 +1 を記録してから株の詳細へ
  await page.goto(`/stems/${parentId}`);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("12");
  await view(page).getByTestId("leaves-new-1").click();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("13", { timeout: ACTION_TIMEOUT });
  await waitForSynced(page);
  await openMat(page, matId, code);

  await view(page).getByTestId("sucker-open").click();
  const sheet = page.getByTestId("sucker-sheet");
  // 今日の観測があっても、既定の前回訪問日は確認日（今日）より前の 10-01
  await expect(sheet.getByTestId("sucker-date")).toHaveValue(todayJst());
  await expect(sheet.getByTestId("sucker-earliest-at")).toHaveValue("2026-10-01");
  // 確認日を前回の巡回の日にすると、それより前の観測はないので空になる。戻すと 10-01 に戻る
  await sheet.getByTestId("sucker-date").fill("2026-10-01");
  await expect(sheet.getByTestId("sucker-earliest-at")).toHaveValue("");
  await sheet.getByTestId("sucker-date").fill(todayJst());
  await expect(sheet.getByTestId("sucker-earliest-at")).toHaveValue("2026-10-01");
  await sheet.getByTestId("sucker-direction-E").click();
  await sheet.getByTestId("sucker-type-sword").click();
  await sheet.getByTestId("sucker-submit").click();
  await expect(sheet).toHaveCount(0);
  await expect(suckerItems(page)).toHaveCount(1);
  await waitForSynced(page);

  const events = await suckerEvents(parentId);
  expect(events).toHaveLength(1);
  // 今日の +1 も含めた累計 13。前回訪問日は確認日より前
  expect(events[0].payload).toMatchObject({ parent_cumulative_leaves: 13, earliest_at: "2026-10-01" });
  expect((events[0].payload as { earliest_at: string }).earliest_at < todayJst()).toBe(true);
});

test("1b. 親茎は既定で最も世代の若い栽培中の茎。選び直すとその茎の累計葉数が記録される", async ({ page }) => {
  const { code, matId } = await newMat();
  const parentId = await createStem(matId, { initialLeafCount: 20 });
  const childId = await createStem(matId, { generation: 2, parentStemId: parentId, initialLeafCount: 6, startedAt: "2026-09-20" });
  await openMat(page, matId, code);

  await view(page).getByTestId("sucker-open").click();
  const sheet = page.getByTestId("sucker-sheet");
  await expect(sheet.getByTestId("sucker-parent")).toHaveValue(parentId);
  await sheet.getByTestId("sucker-parent").selectOption(childId);
  await sheet.getByTestId("sucker-direction-S").click();
  await sheet.getByTestId("sucker-type-water").click();
  await sheet.getByTestId("sucker-submit").click();
  await expect(sheet).toHaveCount(0);

  // 子の吸芽 = 第 3 世代（孫）
  await expect(suckerItems(page)).toHaveCount(1);
  await expect(suckerItems(page).first()).toHaveAttribute("data-generation", "3");
  await waitForSynced(page);
  const sucker = (await stemRows(matId)).find((s) => s.status === "sucker")!;
  expect(sucker).toMatchObject({ generation: 3, parent_stem_id: childId });
  expect(await suckerEvents(parentId)).toHaveLength(0);
  const events = await suckerEvents(childId);
  expect(events).toHaveLength(1);
  expect(events[0].payload).toMatchObject({ parent_cumulative_leaves: 6, direction: "S", sucker_type: "water", earliest_at: null });
});

test("2. オフラインで記録し、オンラインに戻すと stems と events の両方がサーバーにある。再送しても二重にならない", async ({ page, context }) => {
  const { code, matId } = await newMat();
  const parentId = await createStem(matId, { initialLeafCount: 12 });
  await openMat(page, matId, code);

  await context.setOffline(true);
  await recordSucker(page, "W", "water");

  // 未同期 1。吸芽は「未同期」の印付きで即座に出る（まだサーバーに無いのでリンクにしない）
  await expect(pendingCount(page)).toHaveText("1", { timeout: ACTION_TIMEOUT });
  await expect(suckerItems(page)).toHaveCount(1);
  await expect(suckerItems(page).first()).toHaveAttribute("data-pending", "true");
  await expect(suckerItems(page).first().getByTestId("stem-pending")).toHaveText("未同期");
  await expect(suckerItems(page).first().getByTestId("stem-status")).toHaveText("吸芽");
  await expect(suckerItems(page).first().getByTestId("stem-link")).toHaveCount(0);
  // サーバーにはまだ無い（テスト側の Node はオンライン）
  expect(await stemRows(matId)).toHaveLength(1);
  expect(await suckerEvents(parentId)).toHaveLength(0);

  // 再送の検証用に、端末の outbox 項目をそのまま控えておく
  const outboxItem = await readOutbox(page);
  expect(outboxItem).toHaveLength(1);
  const saved = outboxItem[0] as { id: string; stem_id: string; payload: { method: string; sucker_stem_id: string } };
  expect(saved.stem_id).toBe(parentId);
  expect(saved.payload.method).toBe("record_sucker_emerged");

  // オンラインに戻す → 同期 → 0 件。stems と events の両方がサーバーにある
  await context.setOffline(false);
  await expect(pendingCount(page)).toHaveText("0", { timeout: ACTION_TIMEOUT });
  const stems = await stemRows(matId);
  expect(stems).toHaveLength(2);
  expect(stems[1]).toMatchObject({ id: saved.payload.sucker_stem_id, status: "sucker", generation: 2, parent_stem_id: parentId, organization_id: ORG_A });
  const events = await suckerEvents(parentId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ id: saved.id, payload: { sucker_stem_id: saved.payload.sucker_stem_id, parent_cumulative_leaves: 12, direction: "W", sucker_type: "water" } });
  // 画面はサーバーの最新に揃い、未同期の印が消える
  await expect(suckerItems(page).first()).not.toHaveAttribute("data-pending", "true", { timeout: ACTION_TIMEOUT });
  await expect(suckerItems(page)).toHaveCount(1);

  // 再送: 同じ outbox 項目をもう一度積んで同期させても、stems も events も増えない
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
    { dbName: DB_NAME, item: outboxItem[0] },
  );
  // IndexedDB への直接の書き込みは Dexie の購読に乗らないので、件数ではなく outbox の中身で確かめる
  expect(await readOutbox(page)).toHaveLength(1);
  await page.getByTestId("sync-indicator").click();
  await page.getByTestId("sync-panel").getByTestId("sync-now").click();
  // 同期ワーカーが送って outbox から消す（RPC は同じ id なので何もせず成功する）
  await expect.poll(async () => (await readOutbox(page)).length, { timeout: ACTION_TIMEOUT }).toBe(0);
  await expect(pendingCount(page)).toHaveText("0", { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("sync-attention-count")).toHaveCount(0);
  expect(await stemRows(matId)).toHaveLength(2);
  expect(await suckerEvents(parentId)).toHaveLength(1);

  // RPC を直接 2 回呼んでも同じ（p_event_id で冪等。2 回目は何もしない）
  const supabase = await supabaseAsA();
  const call = () =>
    supabase.rpc("record_sucker_emerged", {
      p_event_id: saved.id,
      p_sucker_stem_id: saved.payload.sucker_stem_id,
      p_parent_stem_id: parentId,
      p_occurred_at: new Date().toISOString(),
      p_payload: { parent_cumulative_leaves: 99 },
      p_note: null,
    });
  for (let i = 0; i < 2; i++) {
    const r = await call();
    expect(r.error).toBeNull();
    expect(r.data).toBe(saved.id);
  }
  expect(await stemRows(matId)).toHaveLength(2);
  const after = await suckerEvents(parentId);
  expect(after).toHaveLength(1);
  expect(after[0].payload).toMatchObject({ parent_cumulative_leaves: 12 });
});

test("3. 栽培中の茎が 3 本の株でも吸芽は記録できる", async ({ page }) => {
  const { code, matId } = await newMat();
  const p = await createStem(matId, { initialLeafCount: 25, status: "flowered" });
  const c = await createStem(matId, { generation: 2, parentStemId: p, initialLeafCount: 10, startedAt: "2026-06-01" });
  await createStem(matId, { generation: 3, parentStemId: c, initialLeafCount: 3, startedAt: "2026-09-01" });
  await openMat(page, matId, code);

  // 茎の登録は 3 本で止まるが、「吸芽が出た」は出る
  await expect(view(page).getByTestId("stem-add-blocked")).toBeVisible();
  await expect(view(page).getByTestId("sucker-open")).toBeVisible();

  await view(page).getByTestId("sucker-open").click();
  // 既定の親茎は最も世代の若い（出蕾済みの）親
  await expect(page.getByTestId("sucker-sheet").getByTestId("sucker-parent")).toHaveValue(p);
  await page.getByTestId("sucker-sheet").getByTestId("sucker-cancel").click();
  await recordSucker(page, "N", "sword");
  await expect(suckerItems(page)).toHaveCount(1);
  await waitForSynced(page);
  await expect(page.getByTestId("sync-attention-count")).toHaveCount(0);

  // サーバーに 4 本目（吸芽）がある。栽培中は 3 本のまま
  const stems = await stemRows(matId);
  expect(stems).toHaveLength(4);
  expect(stems.filter((s) => s.status === "active" || s.status === "flowered")).toHaveLength(3);
  expect(stems.filter((s) => s.status === "sucker")).toEqual([expect.objectContaining({ parent_stem_id: p, generation: 2 })]);
  expect(await suckerEvents(p)).toHaveLength(1);

  // 吸芽が出ても茎の登録は 3 本のまま止まっている
  await page.reload();
  await expect(view(page).getByTestId("stem-add-blocked")).toBeVisible();
  await expect(suckerItems(page)).toHaveCount(1);
});

test("3b. 栽培中の茎が無い株では「吸芽が出た」を出さず理由を表示する", async ({ page }) => {
  const { code, matId } = await newMat();
  await createStem(matId, { initialLeafCount: 30, status: "harvested" });
  await openMat(page, matId, code);
  await expect(view(page).getByTestId("sucker-open")).toHaveCount(0);
  await expect(view(page).getByTestId("sucker-blocked")).toHaveText("栽培中の茎がないため、吸芽を記録できません");
});
