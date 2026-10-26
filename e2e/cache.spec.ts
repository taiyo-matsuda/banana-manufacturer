import type { BrowserContext, Page } from "@playwright/test";
import { ACTION_TIMEOUT, accountA, expect, login, noSession, supabaseAsA, test } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";

// 2-9 読み取りのローカルキャッシュ（offline-sync.md 5 章）。完了条件 1・2 を 1 つずつ検証し、加えて
// 訂正（2-6）がキャッシュに反映されること、履歴画面に未送信分が「未同期」で出ること（オンラインの RSC と殻の両方）、
// 殻に最終同期の日時が出ること、ログアウトでキャッシュ・ナビゲーションのキャッシュが消えること（未同期ありの確認も）を検証する。
// 完了条件 3（速度）は docs/04_ops/perf.md（scripts/perf/measure.mjs の前後の数値）。
// テスト農園 A でログイン済み（setup の storageState）。ログインはログアウトのテストの 1 回だけ。
// 圃場の名前は E2E で始める。各テストは新しいブラウザコンテキスト（端末のキャッシュは空）から始め、最初の取り込みは全件なので、
// E2E の掃除でサーバーの行が消えていても整合する。

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DB_NAME = "banana-field-notes";

const view = (page: Page) => page.locator("main:visible");
const pendingCount = (page: Page) => page.getByTestId("sync-pending-count");

// 登録した SW がこのページを制御するまで待つ（pwa.spec.ts と同じ）
async function waitForController(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: ACTION_TIMEOUT });
}

// 端末のキャッシュの取り込みが終わるまで待つ。after を渡すと、その日時より後に終わった取り込みを待つ
async function waitForCacheSynced(page: Page, after?: string) {
  const status = page.getByTestId("sync-status");
  await expect
    .poll(
      async () => {
        const at = await status.getAttribute("data-cache-synced-at");
        const running = await status.getAttribute("data-cache-running");
        if (!at || running === "true") return false;
        return after ? Date.parse(at) > Date.parse(after) : true;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return (await status.getAttribute("data-cache-synced-at"))!;
}

// オンラインでホームを開き、SW の制御と端末のキャッシュの取り込み（初回は全件）を待つ
async function openHomeAndSync(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("organization-name")).toBeVisible();
  await waitForController(page);
  return waitForCacheSynced(page);
}

// 同期状態のパネルの「今すぐ同期」（outbox の送信とキャッシュの差分）
async function syncNow(page: Page, after: string) {
  await page.getByTestId("sync-indicator").click();
  await page.getByTestId("sync-now").click();
  const at = await waitForCacheSynced(page, after);
  await page.getByTestId("sync-close").click();
  return at;
}

// IndexedDB（Dexie のストア）を直接読む
async function idbAll(page: Page, store: string): Promise<Record<string, unknown>[]> {
  return page.evaluate(
    ({ dbName, store }) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const req = indexedDB.open(dbName);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            resolve([]);
            return;
          }
          const r = db.transaction(store, "readonly").objectStore(store).getAll();
          r.onsuccess = () => {
            db.close();
            resolve(r.result as Record<string, unknown>[]);
          };
          r.onerror = () => reject(r.error);
        };
      }),
    { dbName: DB_NAME, store },
  );
}

// outbox に要確認（自動では送らない）の観測を 1 件入れる（未送信の記録を再現する）
async function putPendingObservation(page: Page, stemId: string, userId: string, value = 1) {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
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
    {
      dbName: DB_NAME,
      item: {
        id,
        kind: "observation",
        stem_id: stemId,
        created_at: at,
        attempts: 5,
        last_error: "[E2E] 要確認として残す",
        next_attempt_at: null,
        needs_attention: 1,
        payload: { id, stem_id: stemId, type: "leaves_new", value, observed_at: at, observed_by: userId },
      },
    },
  );
  return id;
}

async function userIdA() {
  const supabase = await supabaseAsA();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("A のユーザーを取得できません");
  return user.id;
}

async function observationRows(stemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase.from("observations").select("id, type, value, organization_id").eq("stem_id", stemId);
  if (error) throw new Error(`観測を取得できません: ${error.message}`);
  return data!;
}

async function setOffline(context: BrowserContext, offline: boolean) {
  await context.setOffline(offline);
}

test("1. オンラインで一度ホームを開いた後、オフラインで未訪問の株・茎の画面を開いて +1 を記録でき、オンラインに戻すと同期される", async ({
  page,
  context,
}) => {
  const field = await createField("E2Eキャッシュ");
  const matId = await createMat(field.id, `${field.code}-001`);
  const otherMatId = await createMat(field.id, `${field.code}-002`);
  const stemId = await createStem(otherMatId, { initialLeafCount: 5 });
  await createStem(matId, { initialLeafCount: 1 });

  const syncedAt = await openHomeAndSync(page);
  // キャッシュに入ったのは RLS で取れた自組織（テスト農園 A）の行だけ
  const fields = await idbAll(page, "fields");
  expect(fields.some((f) => f.id === field.id)).toBe(true);
  expect(new Set(fields.map((f) => f.organization_id))).toEqual(new Set([ORG_A]));
  expect((await idbAll(page, "stems")).some((s) => s.id === stemId)).toBe(true);

  await setOffline(context, true);
  // まだ開いていない株の詳細（ナビゲーションのキャッシュにない）→ オフラインの殻が端末のキャッシュから描く
  await page.goto(`/mats/${otherMatId}`);
  await expect(page.getByTestId("offline-shell-banner")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("offline-page")).toHaveCount(0);
  await expect(page).toHaveURL(`/mats/${otherMatId}`);
  await expect(view(page).getByTestId("mat-code")).toHaveText(`${field.code}-002`);
  // 殻に最終同期の日時（日本時間）が出る
  const expected = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(syncedAt));
  await expect(page.getByTestId("offline-shell-banner")).toContainText("オフライン表示（最終同期:");
  await expect(page.getByTestId("offline-shell-synced-at")).toHaveText(expected);
  // オンライン前提の操作（茎の登録）は無効で理由が出る
  await expect(view(page).getByTestId("stem-add")).toBeDisabled();
  await expect(view(page).getByTestId("stem-add-offline")).toBeVisible();

  // 殻の中で茎の画面へ（殻の中で完結する）
  const stemRow = view(page).locator(`[data-testid="stem-item"][data-stem-id="${stemId}"]`);
  await expect(stemRow.getByTestId("stem-cumulative-leaves")).toHaveText("5");
  await stemRow.getByTestId("stem-link").click();
  await expect(page).toHaveURL(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(`${field.code}-002`);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("5");
  await expect(page.getByTestId("offline-shell-banner")).toBeVisible();

  // +1 を記録 → 未同期 1、履歴に「未同期」
  await view(page).getByTestId("leaves-new-1").click();
  await expect(pendingCount(page)).toHaveText("1", { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("6");
  await expect(view(page).locator('[data-testid="history-item"][data-pending="true"]')).toHaveCount(1);
  expect(await observationRows(stemId)).toHaveLength(0);

  // オンラインに戻すと同期される
  await setOffline(context, false);
  await expect(pendingCount(page)).toHaveText("0", { timeout: ACTION_TIMEOUT });
  const rows = await observationRows(stemId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ type: "leaves_new", value: 1, organization_id: ORG_A });
});

test("1b. オフラインの殻: 圃場の詳細・地図（タイルの代わりに理由と株の一覧）・ホームも端末のキャッシュから開ける", async ({ page, context }) => {
  const field = await createField("E2Eキャッシュ圃場");
  const matId = await createMat(field.id, `${field.code}-001`);
  await createStem(matId, { initialLeafCount: 2 });

  await openHomeAndSync(page);
  await setOffline(context, true);

  await page.goto(`/fields/${field.id}`);
  await expect(page.getByTestId("offline-shell-banner")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("field-detail-name")).toHaveText(/^E2Eキャッシュ圃場/);
  await expect(view(page).getByTestId("field-detail-code")).toHaveText(field.code);

  // 殻の中で地図へ
  await view(page).getByRole("link", { name: "地図（株の配置）" }).click();
  await expect(page).toHaveURL(`/fields/${field.id}/map`);
  await expect(view(page).getByTestId("offline-map-unavailable")).toContainText("地図はオフラインでは表示できません");
  const matRow = view(page).getByTestId("offline-map-mat");
  await expect(matRow).toHaveCount(1);
  await expect(matRow).toContainText(`${field.code}-001`);
  await expect(matRow).toContainText("栽培中");
  await matRow.getByRole("link").click();
  await expect(page).toHaveURL(`/mats/${matId}`);
  await expect(view(page).getByTestId("mat-code")).toHaveText(`${field.code}-001`);

  // 端末に無い株は理由を出す
  await page.goto(`/mats/${crypto.randomUUID()}`);
  await expect(page.getByTestId("offline-shell-missing")).toContainText("この画面のデータは端末にありません。オンラインで一度同期してください");
  await setOffline(context, false);
});

test("2. 別の端末で記録したものが、差分同期でこちらに出る（オフラインでその茎の画面に記録がある）", async ({ page, context }) => {
  const field = await createField("E2Eキャッシュ差分");
  const matId = await createMat(field.id, `${field.code}-001`);
  const stemId = await createStem(matId, { initialLeafCount: 4 });

  const firstAt = await openHomeAndSync(page);

  // 別の端末（supabase-js で直接）が観測を記録する
  const supabase = await supabaseAsA();
  const obsId = crypto.randomUUID();
  const { error } = await supabase
    .from("observations")
    .insert({ id: obsId, stem_id: stemId, type: "leaves_new", value: 2, observed_at: new Date().toISOString(), observed_by: await userIdA() });
  expect(error).toBeNull();

  // こちらで差分同期（手動）
  await syncNow(page, firstAt);
  const cached = await idbAll(page, "observations");
  expect(cached.find((o) => o.id === obsId)).toMatchObject({ stem_id: stemId, type: "leaves_new" });
  // 差分（全件の取り直しではない）
  const meta = (await idbAll(page, "syncMeta"))[0];
  expect(meta.last_full_at).toBe(firstAt);

  await setOffline(context, true);
  await page.goto(`/stems/${stemId}`);
  await expect(page.getByTestId("offline-shell-banner")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("6");
  const item = view(page).locator(`[data-testid="history-item"][data-id="${obsId}"]`);
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("history-value")).toHaveText("+2");
  await expect(item).not.toHaveAttribute("data-pending", "true");
  await setOffline(context, false);
});

test("2b. 画面復帰（visibilitychange）でも差分同期する", async ({ page }) => {
  const field = await createField("E2Eキャッシュ復帰");
  const matId = await createMat(field.id, `${field.code}-001`);
  const stemId = await createStem(matId, { initialLeafCount: 4 });
  const firstAt = await openHomeAndSync(page);

  const supabase = await supabaseAsA();
  const obsId = crypto.randomUUID();
  await supabase
    .from("observations")
    .insert({ id: obsId, stem_id: stemId, type: "leaves_new", value: 1, observed_at: new Date().toISOString(), observed_by: await userIdA() });

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await waitForCacheSynced(page, firstAt);
  expect((await idbAll(page, "observations")).some((o) => o.id === obsId)).toBe(true);
});

test("3. 訂正（2-6）がキャッシュに反映される（元の行は訂正済み、新しい行に「訂正」の印）", async ({ page, context }) => {
  const field = await createField("E2Eキャッシュ訂正");
  const matId = await createMat(field.id, `${field.code}-001`);
  const stemId = await createStem(matId, { initialLeafCount: 3 });
  const supabase = await supabaseAsA();
  const oldId = crypto.randomUUID();
  const observedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await supabase.from("observations").insert({ id: oldId, stem_id: stemId, type: "leaves_new", value: 2, observed_at: observedAt, observed_by: await userIdA() });

  const firstAt = await openHomeAndSync(page);
  expect((await idbAll(page, "observations")).find((o) => o.id === oldId)).toMatchObject({ superseded_by: null });

  // 別の端末で訂正（RPC correct_observation: 新しい行を追加し、元の行の superseded_by を更新 → updated_at が進む）
  const newId = crypto.randomUUID();
  const { error } = await supabase.rpc("correct_observation", { p_new_id: newId, p_old_id: oldId, p_value: 1, p_observed_at: observedAt });
  expect(error).toBeNull();

  await syncNow(page, firstAt);
  expect((await idbAll(page, "observations")).find((o) => o.id === oldId)).toMatchObject({ superseded_by: newId });

  await setOffline(context, true);
  await page.goto(`/stems/${stemId}/history`);
  await expect(page.getByTestId("offline-shell-banner")).toBeVisible({ timeout: ACTION_TIMEOUT });
  const old = view(page).locator(`[data-testid="history-item"][data-id="${oldId}"]`);
  await expect(old).toHaveAttribute("data-superseded", "true");
  await expect(old.getByTestId("history-superseded")).toHaveText("訂正済み → +1");
  await expect(view(page).locator(`[data-testid="history-item"][data-id="${newId}"]`).getByTestId("history-correction")).toBeVisible();
  // 累計は訂正後の値（3 + 1）
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("4");
  await setOffline(context, false);
});

test("4. 履歴画面に未送信分が「未同期」で重なる（オンラインの RSC の履歴と、オフラインの殻の履歴）", async ({ page, context }) => {
  const field = await createField("E2Eキャッシュ履歴");
  const matId = await createMat(field.id, `${field.code}-001`);
  const stemId = await createStem(matId, { initialLeafCount: 3 });
  await openHomeAndSync(page);

  // オンラインの RSC の履歴: 送れずに残っている（要確認）記録も「未同期」で出る
  const pendingId = await putPendingObservation(page, stemId, await userIdA(), 2);
  await page.goto(`/stems/${stemId}/history`);
  await expect(page.getByTestId("offline-shell-banner")).toHaveCount(0);
  const item = view(page).locator(`[data-testid="history-item"][data-id="${pendingId}"]`);
  await expect(item).toHaveAttribute("data-pending", "true");
  await expect(item.getByTestId("history-pending")).toHaveText("未同期");
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("5");

  // オフラインの殻の履歴: 記録入力で +1（未送信）→ 殻の中で履歴へ → 未送信の 2 件が「未同期」
  await setOffline(context, true);
  await page.goto(`/stems/${stemId}`);
  await expect(page.getByTestId("offline-shell-banner")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await view(page).getByTestId("leaves-new-1").click();
  await expect(pendingCount(page)).toHaveText("2", { timeout: ACTION_TIMEOUT });
  await view(page).getByTestId("stem-history-link").click();
  await expect(page).toHaveURL(`/stems/${stemId}/history`);
  await expect(view(page).locator('[data-testid="history-item"][data-pending="true"]')).toHaveCount(2);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("6");

  // オンラインに戻すと +1 は送られ、要確認の 1 件だけが残る（このコンテキストの端末にだけある）
  await setOffline(context, false);
  await expect(pendingCount(page)).toHaveText("1", { timeout: ACTION_TIMEOUT });
});

test.describe("ログアウト", () => {
  // ログアウトは別のセッション（このテストで 1 回だけログイン）で行う。共有の storageState のセッションは使わない
  test.use({ storageState: noSession });

  test("5. ログアウトでキャッシュ・最終同期・ナビゲーションのキャッシュが消える。未同期があれば確認し、了承したら outbox も消える", async ({ page }) => {
    const field = await createField("E2Eキャッシュログアウト");
    const matId = await createMat(field.id, `${field.code}-001`);
    const stemId = await createStem(matId, { initialLeafCount: 3 });

    await login(page, accountA().email, accountA().password);
    await expect(page.getByTestId("organization-name")).toBeVisible();
    await waitForController(page);
    await waitForCacheSynced(page);
    // ナビゲーションのキャッシュに茎の画面を入れる（SW の制御下で開く）
    await page.goto(`/stems/${stemId}`);
    await expect(view(page).getByTestId("leaves-new-1")).toBeVisible();
    expect((await idbAll(page, "fields")).length).toBeGreaterThan(0);
    expect(await idbAll(page, "syncMeta")).toHaveLength(1);
    const cachedPaths = () =>
      page.evaluate(async () => {
        const out: string[] = [];
        for (const name of (await caches.keys()).filter((n) => n.startsWith("shell-"))) {
          for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
        }
        return out.sort();
      });
    await expect.poll(cachedPaths).toContain(`/stems/${stemId}`);

    // 未同期の記録を 1 件残す（要確認なので自動では送られない）
    await putPendingObservation(page, stemId, await userIdA());
    await page.goto("/fields");
    await expect(pendingCount(page)).toHaveText("1", { timeout: ACTION_TIMEOUT });
    await view(page).getByTestId("logout").click();
    const dialog = page.getByTestId("logout-confirm");
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId("logout-confirm-message")).toHaveText("未同期の記録が 1 件あります。ログアウトすると失われます");

    // やめる → ログアウトしない（何も消えない）
    await page.getByTestId("logout-cancel").click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL("/fields");
    expect(await idbAll(page, "outbox")).toHaveLength(1);
    expect((await idbAll(page, "fields")).length).toBeGreaterThan(0);

    // 了承 → キャッシュ・カーソル・meta・outbox・ナビゲーションのキャッシュが消えてログイン画面へ
    await view(page).getByTestId("logout").click();
    await page.getByTestId("logout-discard").click();
    await expect(page).toHaveURL("/login", { timeout: ACTION_TIMEOUT });
    for (const store of ["fields", "mats", "stems", "observations", "events", "photos", "syncCursors", "syncMeta", "outbox", "pendingPhotos"]) {
      expect(await idbAll(page, store), store).toHaveLength(0);
    }
    const left = await cachedPaths();
    expect(left).not.toContain(`/stems/${stemId}`);
    expect(left).not.toContain("/");
    // 殻と /offline は残す（データを持たない）
    expect(left).toEqual(expect.arrayContaining(["/offline", "/offline-shell"]));
  });
});
