import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, AUTH_STATE_B, expect, supabaseAsA, supabaseAsB, test, waitForSynced } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";
import { addDays, jstDateOf } from "../src/lib/weather/dates";

// 3-5 収穫後の追肥・枯葉処理・確認の提案（prediction.md 6 章）。完了条件 1〜3 を 1 つずつ検証する
// （ルールの判定そのものは src/lib/recommendations/evaluate.test.ts）。
// テスト農園 A でログイン済み（setup の storageState）。テストごとにログインしない。圃場・株・茎は DB に直接作り、
// 記録（収穫・施肥・枯葉処理・現在の葉数・被害）は画面から行う（outbox → 同期 → 再計算の経路を通す）。
// 提案の一覧（/recommendations）には他のテストの提案も並ぶので、行は対象（data-stem-id / data-mat-id）と data-kind で絞る。

const view = (page: Page) => page.locator("main:visible");
const today = () => jstDateOf(new Date());
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function md(date: string) {
  return `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;
}

type RecRow = {
  id: string;
  kind: string;
  target_type: string;
  rule_key: string;
  due_at: string | null;
  reason: string | null;
  status: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  resolved_event_id: string | null;
  organization_id: string;
};

async function recommendations(targetType: "stem" | "mat", targetId: string, kind: string): Promise<RecRow[]> {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("recommendations")
    .select("id, kind, target_type, rule_key, due_at, reason, status, resolved_at, resolved_by, resolution_note, resolved_event_id, organization_id")
    .eq("target_type", targetType)
    .eq("target_id", targetId)
    .eq("kind", kind)
    .order("created_at");
  if (error) throw new Error(`recommendations を読めません: ${error.message}`);
  return (data ?? []) as RecRow[];
}
const statuses = async (targetType: "stem" | "mat", targetId: string, kind: string) =>
  (await recommendations(targetType, targetId, kind)).map((r) => r.status);

async function latestEventId(targetType: "stem" | "mat", targetId: string, type: string): Promise<string> {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("events")
    .select("id")
    .eq("target_type", targetType)
    .eq("target_id", targetId)
    .eq("type", type)
    .is("superseded_by", null)
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (error || !data) throw new Error(`${type} のイベントがありません: ${error?.message}`);
  return data.id as string;
}

let userA: string | null = null;
async function userIdA(): Promise<string> {
  if (userA) return userA;
  const supabase = await supabaseAsA();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("A のユーザーを取得できません");
  userA = user.id;
  return user.id;
}

type Field = Awaited<ReturnType<typeof createField>>;

// 株と茎。adoptedDaysAgo: 植え付け（＝採用）の日（枯葉処理の起点）
async function setupStem(field: Field, seq: number, options: { adoptedDaysAgo?: number; initialLeafCount?: number } = {}) {
  const { adoptedDaysAgo = 10, initialLeafCount = 5 } = options;
  const code = `${field.code}-${String(seq).padStart(3, "0")}`;
  const started = addDays(today(), -adoptedDaysAgo);
  const matId = await createMat(field.id, code, started);
  const stemId = await createStem(matId, { startedAt: started, initialLeafCount });
  return { code, matId, stemId };
}

// 出蕾を DB に直接記録する（収穫の前提。収穫は画面から記録する）
async function recordBudDirect(stemId: string, budDate: string) {
  const supabase = await supabaseAsA();
  const { error } = await supabase.rpc("record_stem_event", {
    p_id: crypto.randomUUID(),
    p_stem_id: stemId,
    p_type: "bud_emerged",
    p_occurred_at: `${budDate}T00:00:00+09:00`,
    p_payload: { cumulative_leaves: 30, leaves_current: 12, girth_cm: 50, earliest_at: null },
  });
  if (error) throw new Error(`出蕾を記録できません: ${error.message}`);
}

// 過去の枯葉処理を DB に直接入れる（同期ワーカーが送るのと同じ events への追記）
async function insertLeavesRemoved(stemId: string, date: string) {
  const supabase = await supabaseAsA();
  const { error } = await supabase.from("events").insert({
    id: crypto.randomUUID(),
    type: "leaves_removed",
    target_type: "stem",
    target_id: stemId,
    occurred_at: `${date}T09:00:00+09:00`,
    recorded_by: await userIdA(),
    payload: { count: 2 },
  });
  if (error) throw new Error(`枯葉処理を入れられません: ${error.message}`);
}

// 同期ワーカーがイベント・観測の送信後に呼ぶのと同じ再計算（推定 → 提案）
async function recompute(page: Page, stemId: string) {
  const res = await page.request.post("/api/predictions/recompute", { data: { stemId } });
  expect(res.status()).toBe(200);
  return res.json();
}

async function openStem(page: Page, stemId: string, code: string) {
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(code, { timeout: ACTION_TIMEOUT });
}

async function openList(page: Page) {
  await page.goto("/recommendations");
  await expect(view(page).getByText("読み込み中…")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("recommendation-list").or(view(page).getByTestId("recommendations-empty"))).toBeVisible({
    timeout: ACTION_TIMEOUT,
  });
}

const stemRow = (page: Page, stemId: string, kind: string) =>
  view(page).locator(`[data-testid="recommendation-row"][data-stem-id="${stemId}"][data-kind="${kind}"]`);
const matRow = (page: Page, matId: string, kind = "fertilize_after_harvest") =>
  view(page).locator(`[data-testid="recommendation-row"][data-target-type="mat"][data-mat-id="${matId}"][data-kind="${kind}"]`);

// 茎の画面で収穫を記録する（outbox → 同期 → 再計算）
async function recordHarvestOnScreen(page: Page) {
  await view(page).getByTestId("event-button-harvested").click();
  const dialog = page.getByTestId("event-dialog");
  await dialog.getByTestId("event-weight-kg").fill("18");
  await dialog.getByTestId("event-submit").click();
  await expect(view(page).getByTestId("stem-status")).toHaveText("収穫済み", { timeout: ACTION_TIMEOUT });
}

// 茎の画面で枯葉処理を記録する（確認の confirm を受け入れる）
async function recordLeavesRemovedOnScreen(page: Page, count: string) {
  page.once("dialog", (d) => void d.accept());
  await view(page).getByTestId("leaves-removed-input").fill(count);
  await view(page).getByTestId("leaves-removed-submit").click();
  await expect(view(page).getByTestId("leaves-removed-input")).toHaveValue("", { timeout: ACTION_TIMEOUT });
}

// 施肥の画面で確定する（確認ダイアログ → 記録）
async function confirmFertilize(page: Page, summary: string) {
  await page.getByTestId("fertilize-submit").click();
  await expect(page.getByTestId("fertilize-confirm-summary")).toHaveText(summary);
  await page.getByTestId("fertilize-confirm-submit").click();
  await expect(page.getByTestId("fertilize-done")).toBeVisible({ timeout: ACTION_TIMEOUT });
}

const fertilizer = (label: string) => `E2E${label}-${test.info().project.name}-${Date.now()}`;

test("完了条件 1: 収穫を記録すると株に「収穫後の追肥」が出て、その株に施肥を記録すると done になる（「実施した」からその株だけ・一括入力の両方）", async ({
  page,
}) => {
  const field = await createField("E2E提案追肥");
  const a = await setupStem(field, 1);
  const b = await setupStem(field, 2);
  for (const s of [a, b]) await recordBudDirect(s.stemId, addDays(today(), -60));
  expect(await recommendations("mat", a.matId, "fertilize_after_harvest")).toEqual([]);

  // 茎 a の収穫を画面から記録 → 同期の後の再計算で、株 a に提案（期限は収穫日 + 7 日）
  await openStem(page, a.stemId, a.code);
  await recordHarvestOnScreen(page);
  await waitForSynced(page);
  await expect.poll(() => statuses("mat", a.matId, "fertilize_after_harvest"), { timeout: ACTION_TIMEOUT }).toEqual(["open"]);
  expect((await recommendations("mat", a.matId, "fertilize_after_harvest"))[0]).toMatchObject({
    target_type: "mat",
    rule_key: `harvest:${today()}`,
    due_at: addDays(today(), 7),
    reason: `収穫（${md(today())}）から 7 日以内に追肥`,
    resolved_at: null,
    organization_id: ORG_A,
  });
  // 株 b も収穫
  await openStem(page, b.stemId, b.code);
  await recordHarvestOnScreen(page);
  await waitForSynced(page);
  await expect.poll(() => statuses("mat", b.matId, "fertilize_after_harvest"), { timeout: ACTION_TIMEOUT }).toEqual(["open"]);

  // 一覧: 種類・対象（株コードだけ）・理由・期限。標準量が未設定なら量を出さず「圃場の標準量を設定してください」
  await openList(page);
  const rowA = matRow(page, a.matId);
  await expect(rowA.getByTestId("recommendation-kind")).toHaveText("収穫後の追肥");
  await expect(rowA.getByTestId("recommendation-target")).toHaveText(a.code);
  await expect(rowA.getByTestId("recommendation-reason")).toHaveText(`収穫（${md(today())}）から 7 日以内に追肥`);
  await expect(rowA.getByTestId("recommendation-due")).toHaveText(`期限 ${md(addDays(today(), 7))}（あと 7 日）`);
  await expect(rowA.getByTestId("recommendation-amount")).toHaveText("圃場の標準量を設定してください");

  // 圃場の詳細の「提案の設定」で標準量を 0.5 kg にすると、一覧に量が出る
  await rowA.getByTestId("recommendation-amount").getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/fields/${field.id}#recommendation-settings$`), { timeout: ACTION_TIMEOUT });
  const form = page.getByTestId("recommendation-params-form");
  await expect(form.getByTestId("recommendation-fertilize-after-harvest-days")).toHaveAttribute("placeholder", "7");
  await form.getByTestId("recommendation-standard-amount").fill("0.5");
  await form.getByTestId("recommendation-standard-unit").selectOption("kg");
  await form.getByTestId("recommendation-params-save").click();
  await expect(form.getByTestId("recommendation-params-saved")).toHaveText("保存しました", { timeout: ACTION_TIMEOUT });
  await openList(page);
  await expect(matRow(page, a.matId).getByTestId("recommendation-amount")).toHaveText("量: 圃場の標準量 0.5 kg");

  // 株 a の「実施した」→ 圃場の施肥の記録が、株 a だけを選び、量に標準量を入れた状態で開く → 記録 → done
  await matRow(page, a.matId).getByTestId("recommendation-done").click();
  await expect(page).toHaveURL(`/fields/${field.id}/fertilize?mat=${a.matId}`, { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("fertilize-only-mat")).toContainText(`${a.code} だけを選んでいます`);
  await expect(page.getByTestId("fertilize-amount")).toHaveValue("0.5");
  await expect(page.getByTestId("fertilize-unit")).toHaveValue("kg");
  const fRow = (code: string) => page.locator(`[data-testid="fertilize-mat-row"][data-code="${code}"]`);
  await expect(fRow(a.code).getByTestId("fertilize-mat-check")).toBeChecked();
  await expect(fRow(b.code).getByTestId("fertilize-mat-check")).not.toBeChecked();
  await page.getByTestId("fertilize-name").fill(fertilizer("追肥"));
  await confirmFertilize(page, "1 株に合計 0.5 kg");

  await expect.poll(() => statuses("mat", a.matId, "fertilize_after_harvest"), { timeout: ACTION_TIMEOUT }).toEqual(["done"]);
  const doneA = (await recommendations("mat", a.matId, "fertilize_after_harvest"))[0];
  expect(doneA).toMatchObject({
    resolution_note: "施肥を記録",
    resolved_by: await userIdA(),
    resolved_event_id: await latestEventId("mat", a.matId, "fertilized"),
  });
  expect(doneA.resolved_at).not.toBeNull();
  // 株 b は施肥していないので open のまま
  expect(await statuses("mat", b.matId, "fertilize_after_harvest")).toEqual(["open"]);

  // 株 b: 圃場の施肥の一括入力（全株）で記録しても done になる
  await page.goto(`/fields/${field.id}/fertilize`);
  await expect(page.getByTestId("fertilize-form")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("fertilize-only-mat")).toHaveCount(0);
  await page.getByTestId("fertilize-name").fill(fertilizer("一括"));
  await page.getByTestId("fertilize-amount").fill("0.4");
  await page.getByTestId("fertilize-unit").selectOption("kg");
  await confirmFertilize(page, "2 株に合計 0.8 kg");
  await expect.poll(() => statuses("mat", b.matId, "fertilize_after_harvest"), { timeout: ACTION_TIMEOUT }).toEqual(["done"]);
  expect((await recommendations("mat", b.matId, "fertilize_after_harvest"))[0]).toMatchObject({
    resolution_note: "施肥を記録",
    resolved_event_id: await latestEventId("mat", b.matId, "fertilized"),
  });
  // a はすでに done（2 件目は作られない）
  expect(await statuses("mat", a.matId, "fertilize_after_harvest")).toEqual(["done"]);

  // 一覧から両方の行が消える
  await openList(page);
  await expect(matRow(page, a.matId)).toHaveCount(0);
  await expect(matRow(page, b.matId)).toHaveCount(0);
});

test("完了条件 1（オフライン・設定・撤去）: 圏外で記録した収穫も同期の後に提案が出る。期限 M は圃場の設定。株を撤去すると「対象が終了」", async ({
  page,
  context,
}) => {
  const field = await createField("E2E提案追肥圏外");
  const s = await setupStem(field, 1);
  await recordBudDirect(s.stemId, addDays(today(), -60));
  const supabase = await supabaseAsA();
  // M = 3 日（圃場の設定）
  const { error } = await supabase.from("field_recommendation_params").upsert({ field_id: field.id, fertilize_after_harvest_days: 3 }, { onConflict: "field_id" });
  expect(error).toBeNull();

  await openStem(page, s.stemId, s.code);
  await waitForSynced(page);
  await context.setOffline(true);
  await recordHarvestOnScreen(page);
  await expect(page.getByTestId("sync-pending-count")).toHaveText("1", { timeout: ACTION_TIMEOUT });
  expect(await recommendations("mat", s.matId, "fertilize_after_harvest")).toEqual([]);

  await context.setOffline(false);
  await waitForSynced(page);
  await expect.poll(() => statuses("mat", s.matId, "fertilize_after_harvest"), { timeout: ACTION_TIMEOUT }).toEqual(["open"]);
  expect((await recommendations("mat", s.matId, "fertilize_after_harvest"))[0]).toMatchObject({
    due_at: addDays(today(), 3),
    reason: `収穫（${md(today())}）から 3 日以内に追肥`,
  });

  // 株を撤去（収穫済みの茎だけなので撤去できる）→ open は「対象が終了」（撤去のイベントと記録者）
  await page.goto(`/mats/${s.matId}/edit`);
  await page.getByTestId("mat-remove-open").click();
  await page.getByTestId("mat-remove-reason").fill("E2E 撤去");
  await page.getByTestId("mat-remove-submit").click();
  await expect(page.getByTestId("mat-removed")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect.poll(() => statuses("mat", s.matId, "fertilize_after_harvest"), { timeout: ACTION_TIMEOUT }).toEqual(["dismissed"]);
  expect((await recommendations("mat", s.matId, "fertilize_after_harvest"))[0]).toMatchObject({
    resolution_note: "対象が終了",
    resolved_event_id: await latestEventId("mat", s.matId, "mat_removed"),
    resolved_by: await userIdA(),
  });
});

test("完了条件 2: 最後の枯葉処理から X 日たった茎に「枯葉処理」が出て、枯葉処理を記録すると done になる", async ({ page }) => {
  const field = await createField("E2E提案枯葉");
  const a = await setupStem(field, 1, { adoptedDaysAgo: 60 });
  const lastRemoved = addDays(today(), -30); // X（既定 30 日）ちょうど
  await insertLeavesRemoved(a.stemId, lastRemoved);
  const b = await setupStem(field, 2, { adoptedDaysAgo: 30 }); // 枯葉処理の記録なし → 採用・植え付けから 30 日
  const c = await setupStem(field, 3, { adoptedDaysAgo: 29 }); // 29 日目はまだ

  for (const s of [a, b, c]) await recompute(page, s.stemId);
  expect(await recommendations("stem", a.stemId, "remove_dead_leaves")).toEqual([
    expect.objectContaining({
      status: "open",
      rule_key: `leaves_removed:${lastRemoved}`,
      due_at: today(),
      reason: `最後の枯葉処理（${md(lastRemoved)}）から 30 日`,
      organization_id: ORG_A,
    }),
  ]);
  expect(await recommendations("stem", b.stemId, "remove_dead_leaves")).toEqual([
    expect.objectContaining({
      status: "open",
      due_at: today(),
      reason: `採用・植え付け（${md(addDays(today(), -30))}）から 30 日。枯葉処理の記録がありません`,
    }),
  ]);
  expect(await recommendations("stem", c.stemId, "remove_dead_leaves")).toEqual([]);

  // 一覧: 種類・対象（株コード・茎）・理由・期限
  await openList(page);
  const row = stemRow(page, a.stemId, "remove_dead_leaves");
  await expect(row.getByTestId("recommendation-kind")).toHaveText("枯葉処理");
  await expect(row.getByTestId("recommendation-target")).toHaveText(`${a.code} 親`);
  await expect(row.getByTestId("recommendation-reason")).toHaveText(`最後の枯葉処理（${md(lastRemoved)}）から 30 日`);
  await expect(row.getByTestId("recommendation-due")).toHaveText(`期限 今日（${md(today())}）`);

  // 「実施した」→ 茎の画面 → 枯葉処理を記録 → 同期の後に done（記録者・イベント）。起点が今日に進むので次の提案はまだ出ない
  await row.getByTestId("recommendation-done").click();
  await expect(page).toHaveURL(`/stems/${a.stemId}`, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(a.code, { timeout: ACTION_TIMEOUT });
  await recordLeavesRemovedOnScreen(page, "3");
  await waitForSynced(page);
  await expect.poll(() => statuses("stem", a.stemId, "remove_dead_leaves"), { timeout: ACTION_TIMEOUT }).toEqual(["done"]);
  const done = (await recommendations("stem", a.stemId, "remove_dead_leaves"))[0];
  expect(done).toMatchObject({
    resolution_note: "枯葉処理を記録",
    resolved_by: await userIdA(),
    resolved_event_id: await latestEventId("stem", a.stemId, "leaves_removed"),
  });
  await recompute(page, a.stemId);
  expect(await statuses("stem", a.stemId, "remove_dead_leaves")).toEqual(["done"]);

  // 一覧から消える
  await openList(page);
  await expect(stemRow(page, a.stemId, "remove_dead_leaves")).toHaveCount(0);
  await expect(stemRow(page, b.stemId, "remove_dead_leaves")).toBeVisible();
});

test("完了条件 2（設定・オフライン）: X は圃場ごとの設定（20 日にすると 20 日たった茎に出る）。圏外で記録した枯葉処理も同期の後に done", async ({
  page,
  context,
}) => {
  const field = await createField("E2E提案枯葉設定");
  const s = await setupStem(field, 1, { adoptedDaysAgo: 22 });
  await recompute(page, s.stemId);
  expect(await recommendations("stem", s.stemId, "remove_dead_leaves")).toEqual([]); // 既定の 30 日では出ない

  await page.goto(`/fields/${field.id}`);
  const form = page.getByTestId("recommendation-params-form");
  await expect(form.getByTestId("recommendation-dead-leaves-interval-days")).toHaveAttribute("placeholder", "30");
  await form.getByTestId("recommendation-dead-leaves-interval-days").fill("366");
  await form.getByTestId("recommendation-params-save").click();
  await expect(form.getByTestId("recommendation-dead-leaves-interval-days-error")).toHaveText("枯葉処理の間隔は 1〜365 日の範囲で入力してください", {
    timeout: ACTION_TIMEOUT,
  });
  await form.getByTestId("recommendation-dead-leaves-interval-days").fill("20");
  await form.getByTestId("recommendation-params-save").click();
  await expect(form.getByTestId("recommendation-params-saved")).toHaveText("保存しました", { timeout: ACTION_TIMEOUT });
  await expect(form.getByTestId("recommendation-dead-leaves-interval-days")).toHaveValue("20");

  // 保存の後の評価で、採用 + 20 日を期限に出る
  const adopted = addDays(today(), -22);
  expect(await recommendations("stem", s.stemId, "remove_dead_leaves")).toEqual([
    expect.objectContaining({
      status: "open",
      due_at: addDays(adopted, 20),
      reason: `採用・植え付け（${md(adopted)}）から 20 日。枯葉処理の記録がありません`,
    }),
  ]);
  const supabase = await supabaseAsA();
  const { data: params } = await supabase
    .from("field_recommendation_params")
    .select("dead_leaves_interval_days, fertilize_after_harvest_days, fertilizer_standard_amount, fertilizer_standard_unit")
    .eq("field_id", field.id)
    .single();
  expect(params).toEqual({ dead_leaves_interval_days: 20, fertilize_after_harvest_days: null, fertilizer_standard_amount: null, fertilizer_standard_unit: null });

  // 圏外で枯葉処理を記録 → 未同期の間は open → 電波が戻って同期されると done
  await openStem(page, s.stemId, s.code);
  await waitForSynced(page);
  await context.setOffline(true);
  await recordLeavesRemovedOnScreen(page, "2");
  await expect(page.getByTestId("sync-pending-count")).toHaveText("1", { timeout: ACTION_TIMEOUT });
  expect(await statuses("stem", s.stemId, "remove_dead_leaves")).toEqual(["open"]);
  await context.setOffline(false);
  await waitForSynced(page);
  await expect.poll(() => statuses("stem", s.stemId, "remove_dead_leaves"), { timeout: ACTION_TIMEOUT }).toEqual(["done"]);
  expect((await recommendations("stem", s.stemId, "remove_dead_leaves"))[0]).toMatchObject({
    resolved_event_id: await latestEventId("stem", s.stemId, "leaves_removed"),
    resolved_by: await userIdA(),
  });
});

test("完了条件 3（検算ずれ）: 累計葉数の検算が 3 枚以上ずれると「確認」が出る。現在の葉数を記録し直すと done", async ({ page, context }) => {
  const field = await createField("E2E提案確認葉");
  const s = await setupStem(field, 1, { initialLeafCount: 5 });
  await openStem(page, s.stemId, s.code);
  await waitForSynced(page);

  // 圏外で現在の葉数 12 を記録（累計 5 と 7 枚ずれる）。茎の画面の警告と同じ式 → 同期の後に「確認」
  await context.setOffline(true);
  await view(page).getByTestId("leaves-current-input").fill("12");
  await view(page).getByTestId("leaves-current-submit").click();
  await expect(view(page).getByTestId("leaf-check-warning")).toHaveText("確認してください（累計 5、検算 12）", { timeout: ACTION_TIMEOUT });
  expect(await recommendations("stem", s.stemId, "inspect")).toEqual([]);
  await context.setOffline(false);
  await waitForSynced(page);
  await expect.poll(() => statuses("stem", s.stemId, "inspect"), { timeout: ACTION_TIMEOUT }).toEqual(["open"]);
  expect((await recommendations("stem", s.stemId, "inspect"))[0]).toMatchObject({
    due_at: today(),
    reason: "累計葉数の検算が 7 枚ずれています（累計 5、検算 12）",
    organization_id: ORG_A,
  });

  // 一覧: 種類「確認」・理由・期限。「実施した」で茎の画面
  await openList(page);
  const row = stemRow(page, s.stemId, "inspect");
  await expect(row.getByTestId("recommendation-kind")).toHaveText("確認");
  await expect(row.getByTestId("recommendation-target")).toHaveText(`${s.code} 親`);
  await expect(row.getByTestId("recommendation-reason")).toHaveText("累計葉数の検算が 7 枚ずれています（累計 5、検算 12）");
  await expect(row.getByTestId("recommendation-due")).toHaveText(`期限 今日（${md(today())}）`);
  await row.getByTestId("recommendation-done").click();
  await expect(page).toHaveURL(`/stems/${s.stemId}`, { timeout: ACTION_TIMEOUT });

  // 数え直して現在の葉数 6 を記録（ずれ 1 枚）→ done（記録者）。ずれが無くなったので次の確認は出ない
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(s.code, { timeout: ACTION_TIMEOUT });
  await view(page).getByTestId("leaves-current-input").fill("6");
  await view(page).getByTestId("leaves-current-submit").click();
  await expect(view(page).getByTestId("leaf-check-warning")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await waitForSynced(page);
  await expect.poll(() => statuses("stem", s.stemId, "inspect"), { timeout: ACTION_TIMEOUT }).toEqual(["done"]);
  expect((await recommendations("stem", s.stemId, "inspect"))[0]).toMatchObject({ resolution_note: "現在の葉数を記録", resolved_by: await userIdA() });
  await openList(page);
  await expect(stemRow(page, s.stemId, "inspect")).toHaveCount(0);
});

test("完了条件 3（重い被害）: 茎の被害が severe なら「確認」が出る。被害を記録し直すと done。軽・中の被害には出ない", async ({ page }) => {
  const field = await createField("E2E提案確認被害");
  const s = await setupStem(field, 1);
  const light = await setupStem(field, 2);

  const recordDamage = async (severity: string) => {
    await view(page).getByTestId("event-button-damage").click();
    const dialog = page.getByTestId("event-dialog");
    await dialog.getByTestId("event-kind").selectOption("lodging");
    await dialog.getByTestId("event-severity").selectOption(severity);
    await dialog.getByTestId("event-submit").click();
    await expect(view(page).getByTestId("event-notice")).toHaveText("被害を記録しました", { timeout: ACTION_TIMEOUT });
    await waitForSynced(page);
  };

  await openStem(page, s.stemId, s.code);
  await recordDamage("severe");
  await expect.poll(() => statuses("stem", s.stemId, "inspect"), { timeout: ACTION_TIMEOUT }).toEqual(["open"]);
  const damageId = await latestEventId("stem", s.stemId, "damage");
  expect((await recommendations("stem", s.stemId, "inspect"))[0]).toMatchObject({
    rule_key: `damage:${damageId}`,
    due_at: today(),
    reason: `重い被害（倒伏・重、${md(today())}）を確認してください`,
  });

  await openStem(page, light.stemId, light.code);
  await recordDamage("moderate");
  await recompute(page, light.stemId);
  expect(await recommendations("stem", light.stemId, "inspect")).toEqual([]);

  await openList(page);
  const row = stemRow(page, s.stemId, "inspect");
  await expect(row.getByTestId("recommendation-kind")).toHaveText("確認");
  await expect(row.getByTestId("recommendation-reason")).toHaveText(`重い被害（倒伏・重、${md(today())}）を確認してください`);

  // 「実施した」→ 茎の画面 → 確認の結果を被害で記録し直す（中）→ done（記録者・イベント）
  await row.getByTestId("recommendation-done").click();
  await expect(page).toHaveURL(`/stems/${s.stemId}`, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(s.code, { timeout: ACTION_TIMEOUT });
  await recordDamage("moderate");
  await expect.poll(() => statuses("stem", s.stemId, "inspect"), { timeout: ACTION_TIMEOUT }).toEqual(["done"]);
  const done = (await recommendations("stem", s.stemId, "inspect"))[0];
  expect(done).toMatchObject({ resolution_note: "被害を記録し直した", resolved_by: await userIdA() });
  expect(done.resolved_event_id).not.toBe(damageId);
  expect(done.resolved_event_id).toBe(await latestEventId("stem", s.stemId, "damage"));
});

test.describe("他組織", () => {
  test.use({ storageState: AUTH_STATE_B });

  test("テスト農園 B からは A の株の提案・3-5 の設定が見えず、B の再計算でも作られない", async ({ page }) => {
    const field = await createField("E2E提案3-5他組織");
    const s = await setupStem(field, 1, { adoptedDaysAgo: 40 });
    const a = await supabaseAsA();
    await a.from("field_recommendation_params").upsert({ field_id: field.id, dead_leaves_interval_days: 10, fertilizer_standard_amount: 1, fertilizer_standard_unit: "kg" }, { onConflict: "field_id" });

    const res = await page.request.post("/api/predictions/recompute", { data: { stemId: s.stemId } });
    expect(await res.json()).toMatchObject({ ok: true, recommendations: { stems: 0, mats: 0, created: 0 } });
    expect(await recommendations("stem", s.stemId, "remove_dead_leaves")).toEqual([]);

    // A の株の提案（A のクライアントで作る）は B から見えない
    const { data: made, error } = await a
      .from("recommendations")
      .insert({ kind: "fertilize_after_harvest", target_type: "mat", target_id: s.matId, rule_key: "harvest:2026-01-01", due_at: today(), reason: "A の提案" })
      .select("id")
      .single();
    expect(error).toBeNull();
    const b = await supabaseAsB();
    const { data: seen } = await b.from("open_recommendations").select("id").eq("id", made!.id);
    expect(seen).toEqual([]);
    const { error: insertError } = await b.from("recommendations").insert({ kind: "fertilize_after_harvest", target_type: "mat", target_id: s.matId });
    expect(insertError).not.toBeNull();
    const { data: params } = await b.from("field_recommendation_params").select("field_id").eq("field_id", field.id);
    expect(params).toEqual([]);

    await openList(page);
    await expect(matRow(page, s.matId)).toHaveCount(0);
  });
});
