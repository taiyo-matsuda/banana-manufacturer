import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, supabaseAsA, test, waitForSynced } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";

// 1-6 茎の記録入力（葉数）。完了条件 1〜3 を 1 つずつ検証し、加えて検算の警告を検証する。
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。テストごとにログインしない。
// テストが作る圃場の名前は E2E で始める。観測・イベントは追記のみで消せないので、
// これらを持つ茎・株・圃場は setup の掃除で残る（global-setup.ts）。残る圃場を増やさないよう、
// この spec では圃場をワーカー（プロジェクト）ごとに 1 つだけ作り、テストごとに株を分ける。

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let sharedField: Awaited<ReturnType<typeof createField>>;
let matSeq = 0;

test.beforeAll(async () => {
  sharedField = await createField("E2E葉数");
});

async function setupStem(initialLeafCount = 4, status: "active" | "harvested" = "active") {
  const field = sharedField;
  matSeq += 1;
  const code = `${field.code}-${String(matSeq).padStart(3, "0")}`;
  const matId = await createMat(field.id, code);
  const stemId = await createStem(matId, { initialLeafCount, status });
  return { field, code, matId, stemId };
}

async function observationRows(stemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("observations")
    .select("id, type, value, observed_at, observed_by, organization_id, superseded_by")
    .eq("stem_id", stemId)
    .order("observed_at");
  if (error) throw new Error(`観測を取得できません: ${error.message}`);
  return data!;
}

async function eventRows(stemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("events")
    .select("id, type, target_type, target_id, occurred_at, recorded_by, payload, organization_id, superseded_by")
    .eq("target_type", "stem")
    .eq("target_id", stemId)
    .order("occurred_at");
  if (error) throw new Error(`イベントを取得できません: ${error.message}`);
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

// クライアント側の遷移（Link）では、前の画面の <main> が display:none で DOM に残る（Next.js の挙動）。
// data-testid は画面をまたいで同じものを使うので、表示中の <main> に絞って探す
const view = (page: Page) => page.locator("main:visible");

async function openStem(page: Page, stemId: string, matCode: string) {
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(matCode);
}

test("1. +1 を押すと累計葉数が 1 増え、再読み込み後も保持される", async ({ page }) => {
  const { code, matId, stemId } = await setupStem(4);

  // 株の詳細の茎一覧から茎の記録入力へ
  await page.goto(`/mats/${matId}`);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("4");
  await view(page).getByTestId("stem-link").click();
  await expect(page).toHaveURL(`/stems/${stemId}`, { timeout: ACTION_TIMEOUT });

  // ヘッダ: 株コード・世代・状態・累計葉数（= 初期葉数 4）
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(code);
  await expect(view(page).getByTestId("stem-generation")).toHaveText("親");
  await expect(view(page).getByTestId("stem-status")).toHaveText("栽培中");
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("4");
  await expect(view(page).getByTestId("history-empty")).toHaveText("記録なし");

  // +1 → 保存ボタンなしで記録され、累計が 5 になる
  await view(page).getByTestId("leaves-new-1").click();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("5", { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("leaves-new-error")).toHaveCount(0);

  // 履歴に「新葉 +1」が出る（記録者はログイン中の profile）
  const item = view(page).getByTestId("history-item");
  await expect(item).toHaveCount(1);
  await expect(item.first()).toHaveAttribute("data-kind", "observation");
  await expect(item.first()).toHaveAttribute("data-type", "leaves_new");
  await expect(item.first().getByTestId("history-label")).toHaveText("新葉");
  await expect(item.first().getByTestId("history-value")).toHaveText("+1");

  // DB: observations に type=leaves_new, value=1, observed_by=A の profile。organization_id はトリガーがコピー
  // （記録は端末の outbox 経由で送られるので、同期が終わるのを待ってから確かめる）
  await waitForSynced(page);
  const rows = await observationRows(stemId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ type: "leaves_new", observed_by: await profileIdA(), organization_id: ORG_A, superseded_by: null });
  expect(Number(rows[0].value)).toBe(1);
  expect(Date.now() - new Date(rows[0].observed_at).getTime()).toBeLessThan(5 * 60_000);

  // 再読み込み後も 5 のまま
  await page.reload();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("5");
  await expect(view(page).getByTestId("history-item")).toHaveCount(1);

  // 株の詳細でも累計 5
  await page.goto(`/mats/${matId}`);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("5");
});

test("1b. +0 / +2 / 数字入力（3 枚以上）も記録され、累計に加算される。負数は理由を表示して記録しない", async ({ page }) => {
  const { code, stemId } = await setupStem(3);
  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("3");

  // +0 も記録する（累計は変わらないが履歴に残る）
  await view(page).getByTestId("leaves-new-0").click();
  await expect(view(page).getByTestId("history-item")).toHaveCount(1, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("history-item").first().getByTestId("history-value")).toHaveText("+0");
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("3");

  // +2
  await view(page).getByTestId("leaves-new-2").click();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("5", { timeout: ACTION_TIMEOUT });

  // 3 枚以上は数字入力
  await view(page).getByTestId("leaves-new-input").fill("4");
  await view(page).getByTestId("leaves-new-submit").click();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("9", { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("leaves-new-input")).toHaveValue("");

  // 負数は記録されない
  await view(page).getByTestId("leaves-new-input").fill("-1");
  await view(page).getByTestId("leaves-new-submit").click();
  await expect(view(page).getByTestId("leaves-new-error")).toHaveText("新たに開いた葉の枚数は 0 以上の整数で入力してください", {
    timeout: ACTION_TIMEOUT,
  });
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("9");

  await waitForSynced(page);
  const rows = await observationRows(stemId);
  expect(rows.map((r) => [r.type, Number(r.value)])).toEqual([
    ["leaves_new", 0],
    ["leaves_new", 2],
    ["leaves_new", 4],
  ]);
  // 履歴は新しい順
  const values = await view(page).getByTestId("history-value").allTextContents();
  expect(values).toEqual(["+4", "+2", "+0"]);
});

test("2. 枯葉処理を 2 枚で記録すると、イベントとして保存され履歴に出る", async ({ page }) => {
  const { code, stemId } = await setupStem(6);
  await openStem(page, stemId, code);

  // イベント系なので確認ダイアログが出る。まずキャンセル → 記録されない
  const dialogs: string[] = [];
  page.once("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await view(page).getByTestId("leaves-removed-input").fill("2");
  await view(page).getByTestId("leaves-removed-submit").click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain("枯葉処理 2 枚");
  await expect(view(page).getByTestId("history-item")).toHaveCount(0);
  expect(await eventRows(stemId)).toHaveLength(0);

  // 確定（accept）→ イベントとして保存され、履歴に「枯葉処理 2 枚」
  page.once("dialog", (d) => void d.accept());
  await view(page).getByTestId("leaves-removed-submit").click();
  const item = view(page).getByTestId("history-item");
  await expect(item).toHaveCount(1, { timeout: ACTION_TIMEOUT });
  await expect(item.first()).toHaveAttribute("data-kind", "event");
  await expect(item.first()).toHaveAttribute("data-type", "leaves_removed");
  await expect(item.first().getByTestId("history-label")).toHaveText("枯葉処理");
  await expect(item.first().getByTestId("history-value")).toHaveText("2 枚");
  await expect(view(page).getByTestId("leaves-removed-input")).toHaveValue("");
  // 枯葉処理は累計葉数を変えない（累計は出蕾予測用で、除去は検算にだけ使う）
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("6");

  // DB: events に type=leaves_removed, target=stem, payload={count: 2}, recorded_by=A の profile
  await waitForSynced(page);
  const rows = await eventRows(stemId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    type: "leaves_removed",
    target_type: "stem",
    target_id: stemId,
    recorded_by: await profileIdA(),
    payload: { count: 2 },
    organization_id: ORG_A,
    superseded_by: null,
  });
  expect(Date.now() - new Date(rows[0].occurred_at).getTime()).toBeLessThan(5 * 60_000);
  // observations には入らない
  expect(await observationRows(stemId)).toHaveLength(0);

  // 再読み込み後も履歴に残る。/stems/[stemId]/history でも同じ一覧
  await page.reload();
  await expect(view(page).getByTestId("history-item")).toHaveCount(1);
  await view(page).getByTestId("stem-history-link").click();
  await expect(page).toHaveURL(`/stems/${stemId}/history`, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-record-link")).toBeVisible();
  await expect(view(page).getByTestId("history-item")).toHaveCount(1);
  await expect(view(page).getByTestId("history-item").first().getByTestId("history-label")).toHaveText("枯葉処理");
  await expect(view(page).getByTestId("history-item").first().getByTestId("history-value")).toHaveText("2 枚");
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("6");
});

test("3. 記録を削除・編集する UI がない（記録入力と履歴の両方）", async ({ page }) => {
  const { code, stemId } = await setupStem(5);
  // 観測とイベントを 1 件ずつ作っておく（記録があっても編集・削除の操作が出ないこと）
  await openStem(page, stemId, code);
  await view(page).getByTestId("leaves-new-1").click();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("6", { timeout: ACTION_TIMEOUT });
  page.once("dialog", (d) => void d.accept());
  await view(page).getByTestId("leaves-removed-input").fill("1");
  await view(page).getByTestId("leaves-removed-submit").click();
  await expect(view(page).getByTestId("history-item")).toHaveCount(2, { timeout: ACTION_TIMEOUT });
  await waitForSynced(page);

  for (const url of [`/stems/${stemId}`, `/stems/${stemId}/history`]) {
    await page.goto(url);
    await expect(view(page).getByTestId("history-item")).toHaveCount(2);
    await expect(page.getByRole("button", { name: /削除|編集|訂正/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /削除|編集|訂正/ })).toHaveCount(0);
    // 履歴の各行にボタン・リンク・入力がない
    await expect(view(page).getByTestId("history-item").locator("button, a, input, select, textarea")).toHaveCount(0);
  }

  // DB の正本: 観測・イベントは削除できず、superseded_by 以外は更新できない
  const supabase = await supabaseAsA();
  const obs = await observationRows(stemId);
  const { error: delError, count } = await supabase
    .from("observations")
    .delete({ count: "exact" })
    .eq("id", obs[0].id);
  expect(delError === null ? count : -1).toBe(0); // 削除ポリシーなし → 0 件
  const { error: updError } = await supabase.from("observations").update({ value: 9 }).eq("id", obs[0].id);
  expect(updError?.message ?? "").toContain("append-only");
  const after = await observationRows(stemId);
  expect(after).toHaveLength(1);
  expect(Number(after[0].value)).toBe(1);
});

test("4. 検算: 現在の葉数を累計より 3 枚以上少なく記録すると警告が出る。差が 2 以下なら出ない", async ({ page }) => {
  const { code, stemId } = await setupStem(10);
  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("leaf-check-warning")).toHaveCount(0);

  // 累計 10 に対して現在の葉数 9（差 1）→ 警告なし。検算値 9 を表示
  await view(page).getByTestId("leaves-current-input").fill("9");
  await view(page).getByTestId("leaves-current-submit").click();
  await expect(view(page).getByTestId("stem-leaves-by-check")).toHaveText("9 枚", { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("leaf-check-warning")).toHaveCount(0);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("10");
  // 履歴に「現在の葉数 9 枚」
  await expect(view(page).getByTestId("history-item").first().getByTestId("history-label")).toHaveText("現在の葉数");
  await expect(view(page).getByTestId("history-item").first().getByTestId("history-value")).toHaveText("9 枚");

  // 現在の葉数 7（差 3）→ 警告「確認してください（累計 10、検算 7）」
  await view(page).getByTestId("leaves-current-input").fill("7");
  await view(page).getByTestId("leaves-current-submit").click();
  await expect(view(page).getByTestId("leaf-check-warning")).toHaveText("確認してください（累計 10、検算 7）", {
    timeout: ACTION_TIMEOUT,
  });
  await waitForSynced(page);
  await page.reload();
  await expect(view(page).getByTestId("leaf-check-warning")).toHaveText("確認してください（累計 10、検算 7）");

  // 枯葉処理 3 枚を記録してから現在の葉数 7 を記録 → 検算 = 7 + 3 = 10 で警告が消える
  page.once("dialog", (d) => void d.accept());
  await view(page).getByTestId("leaves-removed-input").fill("3");
  await view(page).getByTestId("leaves-removed-submit").click();
  await expect(view(page).getByTestId("history-item")).toHaveCount(3, { timeout: ACTION_TIMEOUT });
  await view(page).getByTestId("leaves-current-input").fill("7");
  await view(page).getByTestId("leaves-current-submit").click();
  await expect(view(page).getByTestId("stem-leaves-by-check")).toHaveText("10 枚", { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("leaf-check-warning")).toHaveCount(0);

  await waitForSynced(page);
  const rows = await observationRows(stemId);
  expect(rows.map((r) => [r.type, Number(r.value)])).toEqual([
    ["leaves_current", 9],
    ["leaves_current", 7],
    ["leaves_current", 7],
  ]);
});

test("5. 栽培中でない茎（収穫済み）には記録ボタンが出ず、履歴へのリンクだけ", async ({ page }) => {
  const { code, stemId } = await setupStem(5, "harvested");
  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("stem-status")).toHaveText("収穫済み");
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("5");
  await expect(view(page).getByTestId("record-closed")).toContainText("記録できません");
  await expect(view(page).getByTestId("leaves-new-1")).toHaveCount(0);
  await expect(view(page).getByTestId("leaves-removed-submit")).toHaveCount(0);
  await expect(view(page).getByTestId("leaves-current-submit")).toHaveCount(0);
  await expect(view(page).getByTestId("stem-history-link")).toBeVisible();
  expect(await observationRows(stemId)).toHaveLength(0);
});
