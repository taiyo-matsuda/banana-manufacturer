import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, supabaseAsA, test, waitForSynced } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";

// 2-7 今週見る株（画面 1）。完了条件 1〜3 を 1 つずつ検証し、加えて
// 閾値を 14 日に切り替えると 8 日前の株が消える（端末に保存される）、撤去した株は出ない、
// 圏外で +1 を記録して戻っても消える（未同期の重ね合わせ）、訂正済みの観測は数えない（訂正 RPC 後は新しい行で数える。
// 「訂正済みの観測だけの茎は観測なし扱い」は訂正 RPC では作れない（必ず新しい行が残る）ので src/lib/weekly.test.ts で検証）、
// ホームの区画（右上の閾値・「すべて見る」）を検証する。
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。テストごとにログインしない。
// 圃場の名前は E2E で始める。他のテストの株に影響されないよう、テストごとに圃場を作り /weekly?field=<id> で絞る
// （ホームは組織全体の最初の 20 件なので、ホームでは「出ないこと」と区画の存在を確かめる）。

const view = (page: Page) => page.locator("main:visible");
const rows = (page: Page) => view(page).getByTestId("weekly-row");
const rowOf = (page: Page, code: string) => view(page).locator(`[data-testid="weekly-row"][data-mat-code="${code}"]`);

// 日本時間の n 日前の日付（YYYY-MM-DD）と、その日の正午の observed_at
const jstDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" });
function daysAgo(n: number): string {
  return jstDate.format(new Date(Date.now() - n * 86_400_000));
}
const noonOf = (n: number) => `${daysAgo(n)}T12:00:00+09:00`;

type Field = Awaited<ReturnType<typeof createField>>;

async function newField() {
  return createField("E2E今週");
}

let seq = 0;
async function newMat(field: Field) {
  seq += 1;
  const code = `${field.code}-${String(seq).padStart(3, "0")}`;
  const matId = await createMat(field.id, code);
  return { code, matId };
}

async function insertLeavesNew(stemId: string, value: number, observedAt: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("observations")
    .insert({ stem_id: stemId, type: "leaves_new", value, observed_at: observedAt })
    .select("id")
    .single();
  if (error || !data) throw new Error(`観測を作れません: ${error?.message}`);
  return data.id as string;
}

// 葉の観測が n 日前にある栽培中の茎を持つ株
async function matSeenDaysAgo(field: Field, n: number, initialLeafCount = 5) {
  const { code, matId } = await newMat(field);
  const stemId = await createStem(matId, { initialLeafCount });
  await insertLeavesNew(stemId, 1, noonOf(n));
  return { code, matId, stemId };
}

// 出蕾済みの茎（bud_emerged_at 付き）を持つ株。葉の観測は 1 日前（閾値未満）。出蕾日は n 日前か日付（YYYY-MM-DD）
async function floweredMat(field: Field, bud: number | string) {
  const { code, matId } = await newMat(field);
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("stems")
    .insert({
      mat_id: matId,
      generation: 1,
      status: "flowered",
      started_at: "2026-06-01",
      adopted_at: "2026-06-01",
      initial_leaf_count: 10,
      bud_emerged_at: typeof bud === "number" ? daysAgo(bud) : bud,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`茎を作れません: ${error?.message}`);
  await insertLeavesNew(data.id, 1, noonOf(1));
  return { code, matId, stemId: data.id as string };
}

async function openWeekly(page: Page, fieldId: string) {
  await page.goto(`/weekly?field=${fieldId}`);
  await expect(view(page).getByTestId("weekly-list")).toBeVisible({ timeout: ACTION_TIMEOUT });
}

test("1. 8 日前に記録した株と 2 日前に記録した株があるとき、前者だけが出る", async ({ page }) => {
  const field = await newField();
  const old = await matSeenDaysAgo(field, 8, 5);
  const recent = await matSeenDaysAgo(field, 2);

  await openWeekly(page, field.id);
  await expect(rows(page)).toHaveCount(1);
  const row = rowOf(page, old.code);
  await expect(row).toBeVisible();
  await expect(rowOf(page, recent.code)).toHaveCount(0);
  // 行の中身: 株コード、圃場、代表の茎の状態と累計葉数（初期 5 + 1）、経過日数
  await expect(row.getByTestId("weekly-mat-code")).toHaveText(old.code);
  await expect(row.getByTestId("weekly-field-name")).toContainText("E2E今週");
  await expect(row.getByTestId("weekly-stem")).toHaveText("栽培中・累計 6 枚");
  await expect(row.getByTestId("weekly-days")).toHaveText("8 日前");
  await expect(row.getByTestId("weekly-flowered")).toHaveCount(0);

  // ホーム: 「今週見る株」の区画があり、2 日前の株は出ない
  await page.goto("/");
  const home = view(page).getByTestId("home-weekly");
  await expect(home.getByTestId("weekly-list")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(home.locator(`[data-mat-code="${recent.code}"]`)).toHaveCount(0);

  // タップで株の詳細へ
  await openWeekly(page, field.id);
  await rowOf(page, old.code).getByRole("link").click();
  await expect(page).toHaveURL(`/mats/${old.matId}`);
});

test("2. その株で +1 を記録してホームに戻ると、一覧から消えている", async ({ page }) => {
  const field = await newField();
  // ホームの最初の 20 件に必ず入るよう、出蕾日がとても古い出蕾済みの株にする（出蕾済みは出蕾日の古い順で先頭）
  const target = await floweredMat(field, "2000-01-01");
  const other = await matSeenDaysAgo(field, 9);

  // +1 の前: ホームの「今週見る株」に出ている
  await page.goto("/");
  const home = view(page).getByTestId("home-weekly");
  const homeRow = home.locator(`[data-testid="weekly-row"][data-mat-code="${target.code}"]`);
  await expect(homeRow).toBeVisible({ timeout: ACTION_TIMEOUT });

  // ホーム → 株の詳細 → 茎の記録入力で +1（初期 10 + 1 + 1）
  await homeRow.getByRole("link").click();
  await expect(page).toHaveURL(`/mats/${target.matId}`);
  await view(page).getByTestId("stem-link").first().click();
  await expect(page).toHaveURL(`/stems/${target.stemId}`);
  await view(page).getByTestId("leaves-new-1").click();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("12", { timeout: ACTION_TIMEOUT });
  await waitForSynced(page);

  // 下部タブでホームに戻る: その株は出ない（区画の一覧は表示されている）
  await page.locator('[data-testid="bottom-nav"]:visible').getByTestId("nav-home").click();
  await expect(page).toHaveURL("/");
  const homeAfter = view(page).getByTestId("home-weekly");
  await expect(homeAfter.getByTestId("weekly-list")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(homeAfter.locator(`[data-mat-code="${target.code}"]`)).toHaveCount(0);
  // 再読み込み（サーバーの記録だけ）でも出ない
  await page.reload();
  await expect(view(page).getByTestId("home-weekly").getByTestId("weekly-list")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("home-weekly").locator(`[data-mat-code="${target.code}"]`)).toHaveCount(0);

  // 同じ一覧の全件（圃場で絞り込み）でも消えていて、もう 1 株は残る
  await openWeekly(page, field.id);
  await expect(rowOf(page, target.code)).toHaveCount(0);
  await expect(rowOf(page, other.code)).toBeVisible();
  await expect(rows(page)).toHaveCount(1);
});

test("3. 出蕾済みの株が一覧の上に出る（出蕾日の古い順。閾値未満でも出る）", async ({ page }) => {
  const field = await newField();
  const long = await matSeenDaysAgo(field, 20);
  const mid = await matSeenDaysAgo(field, 10);
  const budRecent = await floweredMat(field, 3);
  const budOld = await floweredMat(field, 30);

  await openWeekly(page, field.id);
  await expect(rows(page)).toHaveCount(4);
  const codes = await rows(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-mat-code")));
  expect(codes).toEqual([budOld.code, budRecent.code, long.code, mid.code]);

  const first = rowOf(page, budOld.code);
  await expect(first).toHaveAttribute("data-flowered", "true");
  await expect(first.getByTestId("weekly-flowered")).toHaveText("出蕾");
  await expect(first.getByTestId("weekly-stem")).toHaveText("出蕾済み・累計 11 枚");
  await expect(first.getByTestId("weekly-days")).toHaveText("1 日前");
  await expect(rowOf(page, long.code).getByTestId("weekly-days")).toHaveText("20 日前");
  await expect(rowOf(page, long.code).getByTestId("weekly-flowered")).toHaveCount(0);
});

test("4. 閾値を 14 日に切り替えると 8 日前の株が消え、端末に保存される", async ({ page }) => {
  const field = await newField();
  const eight = await matSeenDaysAgo(field, 8);
  const twenty = await matSeenDaysAgo(field, 20);

  await openWeekly(page, field.id);
  await expect(view(page).getByTestId("weekly-threshold-7")).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page)).toHaveCount(2);

  await view(page).getByTestId("weekly-threshold-14").click();
  await expect(view(page).getByTestId("weekly-threshold-14")).toHaveAttribute("aria-pressed", "true");
  await expect(rowOf(page, eight.code)).toHaveCount(0);
  await expect(rowOf(page, twenty.code)).toBeVisible();
  await expect(rows(page)).toHaveCount(1);

  // 再読み込みしても 14 日のまま（localStorage）。ホームの区画の右上も 14 日
  await page.reload();
  await expect(view(page).getByTestId("weekly-threshold-14")).toHaveAttribute("aria-pressed", "true");
  await expect(rowOf(page, twenty.code)).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(rowOf(page, eight.code)).toHaveCount(0);
  await page.goto("/");
  await expect(view(page).getByTestId("home-weekly").getByTestId("weekly-threshold-14")).toHaveAttribute("aria-pressed", "true");

  // 7 日に戻すと再び出る
  await openWeekly(page, field.id);
  await view(page).getByTestId("weekly-threshold-7").click();
  await expect(rowOf(page, eight.code)).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
});

test("5. 撤去した株は出ない（収穫 → 撤去。RPC で記録）", async ({ page }) => {
  const field = await newField();
  const kept = await matSeenDaysAgo(field, 10);
  // 出蕾済みの株（閾値に関係なく出る）を収穫（record_stem_event）してから撤去（remove_mat）する
  const target = await floweredMat(field, 20);

  await openWeekly(page, field.id);
  await expect(rowOf(page, target.code)).toBeVisible();
  await expect(rows(page)).toHaveCount(2);

  const supabase = await supabaseAsA();
  const { error: e1 } = await supabase.rpc("record_stem_event", {
    p_id: crypto.randomUUID(),
    p_stem_id: target.stemId,
    p_type: "harvested",
    p_occurred_at: new Date().toISOString(),
    p_payload: { weight_kg: 10 },
  });
  if (e1) throw new Error(`収穫を記録できません: ${e1.message}`);
  const { error: e2 } = await supabase.rpc("remove_mat", {
    p_event_id: crypto.randomUUID(),
    p_mat_id: target.matId,
    p_occurred_at: new Date().toISOString(),
    p_reason: "E2E",
  });
  if (e2) throw new Error(`株を撤去できません: ${e2.message}`);
  const { data: mat } = await supabase.from("mats").select("status").eq("id", target.matId).single();
  expect(mat?.status).toBe("removed");

  await openWeekly(page, field.id);
  await expect(rowOf(page, kept.code)).toBeVisible();
  await expect(rowOf(page, target.code)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);
});

test("6. 圏外で +1 を記録して戻っても一覧から消える（未同期の記録を重ねる）", async ({ page, context }) => {
  const field = await newField();
  const target = await matSeenDaysAgo(field, 8);
  const other = await matSeenDaysAgo(field, 9);

  await openWeekly(page, field.id);
  await expect(rows(page)).toHaveCount(2);
  await rowOf(page, target.code).getByRole("link").click();
  await expect(page).toHaveURL(`/mats/${target.matId}`);
  await view(page).getByTestId("stem-link").first().click();
  await expect(page).toHaveURL(`/stems/${target.stemId}`);
  // 茎の画面の本文が出てから圏外にする（読み込み中に圏外にすると画面が出ない）
  await expect(view(page).getByTestId("leaves-new-1")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("sync-pending-count")).toHaveText("0", { timeout: ACTION_TIMEOUT });

  await context.setOffline(true);
  await view(page).getByTestId("leaves-new-1").click();
  await expect(page.getByTestId("sync-pending-count")).toHaveText("1", { timeout: ACTION_TIMEOUT });

  // 圏外のまま一覧へ戻る（ブラウザの戻る。オフラインでは RSC を取得できないので、取得済みの画面に戻る）
  await page.goBack();
  await page.goBack();
  await expect(page).toHaveURL(`/weekly?field=${field.id}`);
  await expect(rowOf(page, target.code)).toHaveCount(0);
  await expect(rowOf(page, other.code)).toBeVisible();
  // サーバーにはまだ無い
  const supabase = await supabaseAsA();
  const { data } = await supabase.from("observations").select("id").eq("stem_id", target.stemId);
  expect(data).toHaveLength(1);

  // オンラインに戻すと同期され、再読み込みしても出ない（サーバーの記録で消える）
  await context.setOffline(false);
  await waitForSynced(page);
  await page.reload();
  await expect(rowOf(page, other.code)).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(rowOf(page, target.code)).toHaveCount(0);
});

test("7. 訂正済みの観測は数えない（訂正 RPC 後は新しい日付・値で数える）", async ({ page }) => {
  const field = await newField();
  // 1 日前に +1（閾値未満なので出ない）→ 訂正（correct_observation）で 10 日前・+0 に直すと、
  // 訂正済みの元の行（1 日前・+1）は数えず、新しい行（10 日前・+0）で数える
  const { code, matId } = await newMat(field);
  const stemId = await createStem(matId, { startedAt: daysAgo(30), initialLeafCount: 4 });
  const oldId = await insertLeavesNew(stemId, 1, noonOf(1));

  await openWeekly(page, field.id);
  await expect(rowOf(page, code)).toHaveCount(0);

  const supabase = await supabaseAsA();
  const newId = crypto.randomUUID();
  const { error } = await supabase.rpc("correct_observation", {
    p_new_id: newId,
    p_old_id: oldId,
    p_value: 0,
    p_observed_at: noonOf(10),
  });
  if (error) throw new Error(`観測を訂正できません: ${error.message}`);
  const { data: obs } = await supabase.from("observations").select("id, superseded_by").eq("stem_id", stemId);
  expect(obs?.find((o) => o.id === oldId)?.superseded_by).toBe(newId);

  // 比較: 同じく 1 日前に観測した（訂正されていない）茎は出ない
  const control = await newMat(field);
  const controlStem = await createStem(control.matId, { startedAt: daysAgo(30) });
  await insertLeavesNew(controlStem, 1, noonOf(1));

  await openWeekly(page, field.id);
  const row = rowOf(page, code);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("weekly-days")).toHaveText("10 日前");
  // 累計葉数も訂正済みの観測（+1）を数えない（初期 4 + 0）
  await expect(row.getByTestId("weekly-stem")).toHaveText("栽培中・累計 4 枚");
  await expect(rowOf(page, control.code)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(1);
});

test("8. 0 件なら「今週見る株はありません」。ホームの区画から「すべて見る」で /weekly へ", async ({ page }) => {
  const field = await newField();
  await matSeenDaysAgo(field, 1);
  await openWeekly(page, field.id);
  await expect(view(page).getByTestId("weekly-empty")).toHaveText("今週見る株はありません");
  await expect(rows(page)).toHaveCount(0);

  // ホーム: 区画の見出しと閾値（組織全体に 1 件以上あれば「すべて見る（N 件）」）
  await matSeenDaysAgo(field, 9);
  await page.goto("/");
  const home = view(page).getByTestId("home-weekly");
  await expect(home.getByText("今週見る株", { exact: true })).toBeVisible();
  await expect(home.getByTestId("weekly-threshold-7")).toBeVisible();
  const all = home.getByTestId("weekly-all");
  await expect(all).toHaveText(/すべて見る（\d+ 件）/, { timeout: ACTION_TIMEOUT });
  expect(await home.getByTestId("weekly-row").count()).toBeLessThanOrEqual(20);
  await all.click();
  await expect(page).toHaveURL("/weekly");
  const select = view(page).getByTestId("weekly-field-select");
  await expect(select).toHaveValue("");
  // 圃場で絞り込む（選択式。圃場が多くても一覧を押し出さず、横にはみ出さない）
  await select.selectOption(field.id);
  await expect(page).toHaveURL(`/weekly?field=${field.id}`);
  await expect(view(page).getByTestId("weekly-field-select")).toHaveValue(field.id);
  await expect(rows(page)).toHaveCount(1);
  const box = await view(page).getByTestId("weekly-field-select").boundingBox();
  const width = page.viewportSize()!.width;
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  // すべての圃場に戻す
  await view(page).getByTestId("weekly-field-select").selectOption("");
  await expect(page).toHaveURL("/weekly");
});
