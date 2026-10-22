import path from "node:path";
import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, supabaseAsA, test, waitForSynced } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";

// 1-9 オフライン保存と同期。完了条件 1〜3 を 1 つずつ検証し、加えて
// オフラインで記録したイベント（枯葉処理）の同期、再送しても二重にならないこと（DB 側の冪等性）、
// サーバーに拒否された記録が「要確認」になり手動で再試行できることを検証する。
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。テストごとにログインしない。
// 圃場の名前は E2E で始める。観測・イベントを持つ茎は消せないので、圃場はワーカーごとに 1 つだけ作り、テストごとに株を分ける。
// 注意: オフライン中は Next.js のクライアントナビゲーションや RSC の取得も失敗するので、
// オフラインにする前に茎の画面を開いておく（再読み込みもしない）。

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FIXTURE = path.resolve(__dirname, "fixtures", "stem-side.jpg");
const DB_NAME = "banana-field-notes";

let sharedField: Awaited<ReturnType<typeof createField>>;
let matSeq = 0;

test.beforeAll(async () => {
  sharedField = await createField("E2Eオフライン");
});

async function setupStem(initialLeafCount = 4, status: "active" | "flowered" = "active") {
  matSeq += 1;
  const code = `${sharedField.code}-${String(matSeq).padStart(3, "0")}`;
  const matId = await createMat(sharedField.id, code);
  const stemId = await createStem(matId, { initialLeafCount, status });
  return { code, matId, stemId };
}

async function observationRows(stemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("observations")
    .select("id, type, value, observed_at, observed_by, organization_id")
    .eq("stem_id", stemId)
    .order("observed_at");
  if (error) throw new Error(`観測を取得できません: ${error.message}`);
  return data!;
}

async function eventRows(stemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("events")
    .select("id, type, target_type, target_id, occurred_at, recorded_by, payload, organization_id")
    .eq("target_type", "stem")
    .eq("target_id", stemId)
    .order("occurred_at");
  if (error) throw new Error(`イベントを取得できません: ${error.message}`);
  return data!;
}

async function photoRows(stemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("photos")
    .select("id, storage_path, taken_at, taken_by, target_type, target_id, kind, upload_status, organization_id")
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
  if (!user) throw new Error("A のユーザーを取得できません");
  return user.id;
}

// クライアント側の遷移では前の画面の <main> が DOM に残るので、表示中の <main> に絞る
const view = (page: Page) => page.locator("main:visible");
const pendingCount = (page: Page) => page.getByTestId("sync-pending-count");

async function openStem(page: Page, stemId: string, matCode: string) {
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(matCode);
  // 起動時の同期が終わり、未同期 0 の状態から始める
  await expect(pendingCount(page)).toHaveText("0", { timeout: ACTION_TIMEOUT });
}

test("1. オフラインで +1 を記録すると、未同期件数が 1 になり、画面には即座に反映される（サーバーにはまだ無い）", async ({ page, context }) => {
  const { code, stemId } = await setupStem(4);
  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("4");

  await context.setOffline(true);
  await view(page).getByTestId("leaves-new-1").click();

  // 未同期件数 1。累計葉数は即座に 5。履歴に「新葉 +1」が未同期の印付きで出る
  await expect(pendingCount(page)).toHaveText("1", { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("5");
  await expect(view(page).getByTestId("leaves-new-error")).toHaveCount(0);
  const item = view(page).getByTestId("history-item");
  await expect(item).toHaveCount(1);
  await expect(item.first()).toHaveAttribute("data-kind", "observation");
  await expect(item.first()).toHaveAttribute("data-type", "leaves_new");
  await expect(item.first()).toHaveAttribute("data-pending", "true");
  await expect(item.first().getByTestId("history-value")).toHaveText("+1");
  await expect(item.first().getByTestId("history-pending")).toHaveText("未同期");

  // サーバーにはまだ無い（テスト側の Node はオンライン）
  expect(await observationRows(stemId)).toHaveLength(0);

  // もう 1 件（現在の葉数）を記録すると 2 件。検算も即座に反映
  await view(page).getByTestId("leaves-current-input").fill("5");
  await view(page).getByTestId("leaves-current-submit").click();
  await expect(pendingCount(page)).toHaveText("2", { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-leaves-by-check")).toHaveText("5 枚");
  await expect(view(page).getByTestId("leaves-current-input")).toHaveValue("");
  await expect(view(page).getByTestId("history-pending")).toHaveCount(2);
  expect(await observationRows(stemId)).toHaveLength(0);

  // 同期状態の画面: 未送信 2 件、要確認なし
  await page.getByTestId("sync-indicator").click();
  const panel = page.getByTestId("sync-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("sync-summary")).toHaveText("未送信 2 件・要確認 0 件");
  await expect(panel.getByTestId("sync-waiting-item")).toHaveCount(2);
  await expect(panel.getByTestId("sync-attention-item")).toHaveCount(0);
  await panel.getByTestId("sync-close").click();

  await context.setOffline(false);
});

test("2. オンラインに戻すと同期され、未同期件数が 0 になり、サーバーに記録が存在する", async ({ page, context }) => {
  const { code, matId, stemId } = await setupStem(4);
  await openStem(page, stemId, code);

  await context.setOffline(true);
  await view(page).getByTestId("leaves-new-1").click();
  await expect(pendingCount(page)).toHaveText("1", { timeout: ACTION_TIMEOUT });
  await view(page).getByTestId("leaves-new-2").click();
  await expect(pendingCount(page)).toHaveText("2", { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("7");
  expect(await observationRows(stemId)).toHaveLength(0);

  // オンラインに戻す → online イベントで同期 → 0 件
  await context.setOffline(false);
  await expect(pendingCount(page)).toHaveText("0", { timeout: ACTION_TIMEOUT });

  // サーバーに 2 行（記録した順）。observed_by は A、organization_id はトリガーがコピー
  const rows = await observationRows(stemId);
  expect(rows.map((r) => [r.type, Number(r.value)])).toEqual([
    ["leaves_new", 1],
    ["leaves_new", 2],
  ]);
  const userId = await profileIdA();
  for (const r of rows) {
    expect(r).toMatchObject({ observed_by: userId, organization_id: ORG_A });
    expect(Date.now() - new Date(r.observed_at).getTime()).toBeLessThan(5 * 60_000);
  }

  // 画面はサーバーの最新に揃い、未同期の印が消える。累計は 7 のまま、履歴は 2 件
  await expect(view(page).getByTestId("history-pending")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("7");
  await expect(view(page).getByTestId("history-item")).toHaveCount(2);
  await expect(view(page).locator('[data-testid="history-item"][data-pending]')).toHaveCount(0);

  // 再読み込み後も 7。株の詳細でも 7
  await page.reload();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("7");
  await expect(view(page).getByTestId("history-item")).toHaveCount(2);
  await expect(pendingCount(page)).toHaveText("0");
  await page.goto(`/mats/${matId}`);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("7");
});

test("3. オフラインで記録した写真も同様に同期される（Storage と photos）", async ({ page, context }) => {
  const { code, stemId } = await setupStem();
  await openStem(page, stemId, code);

  await context.setOffline(true);
  await view(page).getByTestId("photo-kind").selectOption("bud");
  await view(page).getByTestId("photo-input").setInputFiles(FIXTURE);

  // 未同期 1。履歴に写真が未同期の印付きで出て、端末の Blob からサムネイルが表示される
  await expect(pendingCount(page)).toHaveText("1", { timeout: ACTION_TIMEOUT });
  const item = view(page).getByTestId("history-item");
  await expect(item).toHaveCount(1);
  await expect(item.first()).toHaveAttribute("data-kind", "photo");
  await expect(item.first()).toHaveAttribute("data-type", "bud");
  await expect(item.first()).toHaveAttribute("data-pending", "true");
  await expect(item.first().getByTestId("history-pending")).toHaveText("未同期");
  await expect(view(page).getByTestId("photo-error")).toHaveCount(0);
  const thumb = item.first().getByTestId("history-photo-thumb");
  await expect(thumb).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() => thumb.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth), { timeout: ACTION_TIMEOUT })
    .toBeGreaterThan(0);
  expect(await photoRows(stemId)).toHaveLength(0);

  // オンラインに戻す → Storage にアップロード → photos に追記 → 0 件
  await context.setOffline(false);
  await expect(pendingCount(page)).toHaveText("0", { timeout: ACTION_TIMEOUT });

  const rows = await photoRows(stemId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    target_type: "stem",
    target_id: stemId,
    taken_by: await profileIdA(),
    kind: "bud",
    upload_status: "uploaded",
    organization_id: ORG_A,
    storage_path: `${ORG_A}/stem/${stemId}/${rows[0].id}.jpg`,
  });
  // EXIF の撮影日時（fixtures/stem-side.jpg: 2026:10:20 09:15:30、ブラウザのタイムゾーンで解釈）
  expect(new Date(rows[0].taken_at).getUTCFullYear()).toBe(2026);
  // Storage に実体がある
  const supabase = await supabaseAsA();
  const folder = rows[0].storage_path.slice(0, rows[0].storage_path.lastIndexOf("/"));
  const { data: objects, error: listError } = await supabase.storage.from("photos").list(folder);
  expect(listError).toBeNull();
  expect(objects?.map((o) => o.name)).toContain(`${rows[0].id}.jpg`);

  // 画面はサーバーの最新に揃い、サムネイルは署名付き URL になる
  await expect(view(page).getByTestId("history-pending")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  const thumb2 = view(page).getByTestId("history-photo-thumb");
  await expect(thumb2).toHaveAttribute("src", /\/storage\/v1\/object\/sign\/photos\//, { timeout: ACTION_TIMEOUT });
  await expect(thumb2).toHaveAttribute("data-photo-id", rows[0].id);
  await expect
    .poll(() => thumb2.evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth), { timeout: ACTION_TIMEOUT })
    .toBeGreaterThan(0);
});

test("4. オフラインで記録したイベント（枯葉処理）も同期後にサーバーにある。同じ id を再送しても二重にならない", async ({ page, context }) => {
  const { code, stemId } = await setupStem(6);
  await openStem(page, stemId, code);

  await context.setOffline(true);
  page.once("dialog", (d) => void d.accept());
  await view(page).getByTestId("leaves-removed-input").fill("2");
  await view(page).getByTestId("leaves-removed-submit").click();
  await expect(pendingCount(page)).toHaveText("1", { timeout: ACTION_TIMEOUT });
  const item = view(page).getByTestId("history-item");
  await expect(item).toHaveCount(1);
  await expect(item.first()).toHaveAttribute("data-kind", "event");
  await expect(item.first()).toHaveAttribute("data-type", "leaves_removed");
  await expect(item.first()).toHaveAttribute("data-pending", "true");
  await expect(item.first().getByTestId("history-value")).toHaveText("2 枚");
  await expect(view(page).getByTestId("leaves-removed-input")).toHaveValue("");
  expect(await eventRows(stemId)).toHaveLength(0);

  await context.setOffline(false);
  await expect(pendingCount(page)).toHaveText("0", { timeout: ACTION_TIMEOUT });
  const events = await eventRows(stemId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "leaves_removed",
    target_type: "stem",
    target_id: stemId,
    recorded_by: await profileIdA(),
    payload: { count: 2 },
    organization_id: ORG_A,
  });

  // 冪等性（DB 側）: 同期ワーカーと同じ upsert(ignoreDuplicates) で同じ id を再送しても、行は増えず値も変わらない
  const supabase = await supabaseAsA();
  const { error: eventResend } = await supabase
    .from("events")
    .upsert(
      { id: events[0].id, type: "leaves_removed", target_type: "stem", target_id: stemId, occurred_at: events[0].occurred_at, recorded_by: events[0].recorded_by, payload: { count: 99 } },
      { onConflict: "id", ignoreDuplicates: true },
    );
  expect(eventResend).toBeNull();
  const eventsAfter = await eventRows(stemId);
  expect(eventsAfter).toHaveLength(1);
  expect(eventsAfter[0].payload).toEqual({ count: 2 });

  // 観測も同様（オンラインのまま +1 → 同期 → 同じ id で value=5 を再送しても value=1 のまま）
  await view(page).getByTestId("leaves-new-1").click();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("7", { timeout: ACTION_TIMEOUT });
  await waitForSynced(page);
  const obs = await observationRows(stemId);
  expect(obs).toHaveLength(1);
  const { error: obsResend } = await supabase
    .from("observations")
    .upsert({ id: obs[0].id, stem_id: stemId, type: "leaves_new", value: 5, observed_at: obs[0].observed_at }, { onConflict: "id", ignoreDuplicates: true });
  expect(obsResend).toBeNull();
  const obsAfter = await observationRows(stemId);
  expect(obsAfter).toHaveLength(1);
  expect(Number(obsAfter[0].value)).toBe(1);

  // RPC record_stem_event も p_id で冪等: 同じ id で 2 回呼んでも events は 1 行、2 回目は状態を検査しない
  const eventId = crypto.randomUUID();
  const call = () =>
    supabase.rpc("record_stem_event", {
      p_id: eventId,
      p_stem_id: stemId,
      p_type: "bud_emerged",
      p_occurred_at: new Date().toISOString(),
      p_payload: { cumulative_leaves: 7, leaves_current: 7, girth_cm: 40, earliest_at: null },
      p_note: null,
    });
  const first = await call();
  expect(first.error).toBeNull();
  expect(first.data).toBe(eventId);
  const second = await call(); // 既に flowered だが、同じ id なので「出蕾は栽培中の茎にだけ」にはならない
  expect(second.error).toBeNull();
  expect(second.data).toBe(eventId);
  const budEvents = (await eventRows(stemId)).filter((e) => e.type === "bud_emerged");
  expect(budEvents).toHaveLength(1);
  expect(budEvents[0].id).toBe(eventId);
});

test("5. サーバーに拒否された記録（状態の前提違反）は再試行せず「要確認」になり、理由が見え、手動で再試行できる", async ({ page }) => {
  const { code, stemId } = await setupStem(4, "active");
  await openStem(page, stemId, code);
  const userId = await profileIdA();

  // 栽培中（active）の茎に「袋掛け」の RPC 項目を outbox に直接入れる（画面からは出せない組み合わせ。
  // 別の端末で先に状態が変わった、などサーバーで拒否される記録の再現）。Dexie のストアに IndexedDB で直接書く
  const itemId = crypto.randomUUID();
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
        id: itemId,
        kind: "event",
        stem_id: stemId,
        created_at: new Date().toISOString(),
        attempts: 0,
        last_error: null,
        next_attempt_at: null,
        needs_attention: 0,
        payload: { method: "record_stem_event", id: itemId, stem_id: stemId, type: "bagged", occurred_at: new Date().toISOString(), payload: {}, note: null, recorded_by: userId },
      },
    },
  );

  // 手動同期 → 1 回で要確認（再試行しない）。件数 1、要確認 1、理由（RPC の日本語メッセージ）が見える
  await page.getByTestId("sync-indicator").click();
  const panel = page.getByTestId("sync-panel");
  await panel.getByTestId("sync-now").click();
  await expect(page.getByTestId("sync-attention-count")).toHaveText("要確認 1", { timeout: ACTION_TIMEOUT });
  await expect(pendingCount(page)).toHaveText("1");
  const attention = panel.getByTestId("sync-attention-item");
  await expect(attention).toHaveCount(1);
  await expect(attention.first()).toHaveAttribute("data-item-id", itemId);
  await expect(attention.first().getByTestId("sync-attention-label")).toHaveText("袋掛け");
  await expect(attention.first().getByTestId("sync-attention-error")).toContainText("袋掛けは出蕾済みの茎にだけ記録できます");
  await expect(attention.first()).toContainText("1 回失敗");
  await expect(panel.getByTestId("sync-summary")).toHaveText("未送信 0 件・要確認 1 件");
  expect(await eventRows(stemId)).toHaveLength(0);

  // 手動で再試行 → もう一度送って、同じ理由で要確認のまま（2 回失敗）。自動では送られない
  await attention.first().getByTestId("sync-retry").click();
  await expect(attention.first()).toContainText("2 回失敗", { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("sync-attention-count")).toHaveText("要確認 1");
  expect(await eventRows(stemId)).toHaveLength(0);

  // 要確認があっても、他の記録は送れる（+1 → 同期済み、件数は要確認の 1 件だけ残る）
  await view(page).getByTestId("leaves-new-1").click();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("5", { timeout: ACTION_TIMEOUT });
  await expect(pendingCount(page)).toHaveText("1", { timeout: ACTION_TIMEOUT });
  await expect.poll(async () => (await observationRows(stemId)).length, { timeout: ACTION_TIMEOUT }).toBe(1);
  await expect(page.getByTestId("sync-attention-count")).toHaveText("要確認 1");
});
