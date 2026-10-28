import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, AUTH_STATE_B, expect, supabaseAsA, supabaseAsB, test, waitForSynced } from "./helpers";
import { createField, createMat, createStem, dwarfNamwaId } from "./map-helpers";
import { addDays, eachDate, jstDateOf } from "../src/lib/weather/dates";

// 3-4 提案の基盤と、袋掛け・摘蕾・収穫期（prediction.md 6 章）。完了条件 1〜3 を 1 つずつ検証する
// （ルールの判定そのものは src/lib/recommendations/evaluate.test.ts）。
// テスト農園 A でログイン済み（setup の storageState）。テストごとにログインしない。圃場・株・茎は DB に直接作る。
// ホームの「提案」には他のテストの提案も並ぶので、行は data-stem-id と data-kind で絞る。
//
// 収穫期の気温（収穫予測 3-3 と同じ作り。基準温度 14℃）: 平年値 24℃（10 ℃・日/日）、出蕾（6 日前）の翌日〜昨日は 30℃（16/日）→ 実績 80。
// 目標積算温度を 100（圃場 × 品種の設定）にすると、下限 90 は今日（80 + 10）、予測日 100 は明日、上限 110 は明後日 → 下限が 7 日以内。

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
  target_id: string;
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

// 3-4 の種類だけ（3-5 の枯葉処理・確認も同じ茎に出る。茎は植え付けから 150 日で、出蕾の記録は現在の葉数も残すため。
// 3-5 の提案は recommendations-after-harvest.spec.ts）
const KINDS_3_4 = ["bag", "debud", "harvest_window"];

async function recommendations(stemId: string): Promise<RecRow[]> {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("recommendations")
    .select("id, kind, target_type, target_id, rule_key, due_at, reason, status, resolved_at, resolved_by, resolution_note, resolved_event_id, organization_id")
    .eq("target_type", "stem")
    .eq("target_id", stemId)
    .in("kind", KINDS_3_4)
    .order("kind");
  if (error) throw new Error(`recommendations を読めません: ${error.message}`);
  return (data ?? []) as RecRow[];
}

async function eventId(stemId: string, type: string): Promise<string> {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("events")
    .select("id")
    .eq("target_type", "stem")
    .eq("target_id", stemId)
    .eq("type", type)
    .is("superseded_by", null)
    .single();
  if (error || !data) throw new Error(`${type} のイベントがありません: ${error?.message}`);
  return data.id as string;
}

async function userIdA(): Promise<string> {
  const supabase = await supabaseAsA();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("A のユーザーを取得できません");
  return user.id;
}

async function setupStem(prefix: string, field?: Awaited<ReturnType<typeof createField>>, seq = 1, startedDaysAgo = -150) {
  const f = field ?? (await createField(prefix));
  const code = `${f.code}-${String(seq).padStart(3, "0")}`;
  const matId = await createMat(f.id, code, addDays(today(), startedDaysAgo));
  const stemId = await createStem(matId, { startedAt: addDays(today(), startedDaysAgo), initialLeafCount: 5 });
  return { field: f, code, matId, stemId };
}

// 出蕾を DB に直接記録する（画面からの記録は完了条件 1・2 で検証する）
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

// 同期ワーカーがイベントの送信後に呼ぶのと同じ再計算（推定 → 提案）
async function recompute(page: Page, stemId: string) {
  const res = await page.request.post("/api/predictions/recompute", { data: { stemId } });
  expect(res.status()).toBe(200);
  return res.json();
}

async function openStem(page: Page, stemId: string, code: string) {
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(code, { timeout: ACTION_TIMEOUT });
}

// 茎の画面で出蕾を記録する（outbox → 同期 → 再計算）
async function recordBudOnScreen(page: Page, budDate: string) {
  await view(page).getByTestId("event-button-bud_emerged").click();
  const dialog = page.getByTestId("event-dialog");
  await dialog.getByTestId("event-date").fill(budDate);
  await dialog.getByTestId("event-leaves-current").fill("12");
  await dialog.getByTestId("event-girth-cm").fill("50");
  await dialog.getByTestId("event-submit").click();
  await expect(view(page).getByTestId("event-notice")).toHaveText("出蕾を記録しました", { timeout: ACTION_TIMEOUT });
  await waitForSynced(page);
}

const homeRow = (page: Page, stemId: string, kind: string) =>
  view(page).locator(`[data-testid="recommendation-row"][data-stem-id="${stemId}"][data-kind="${kind}"]`);

// 提案の全件の一覧（/recommendations）。ホームは 3 件だけなので、特定の茎の行はこちらで探す
async function openList(page: Page) {
  await page.goto("/recommendations");
  await expect(view(page).getByText("読み込み中…")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("recommendation-list").or(view(page).getByTestId("recommendations-empty"))).toBeVisible({
    timeout: ACTION_TIMEOUT,
  });
}

async function openHome(page: Page) {
  await page.goto("/");
  await expect(view(page).getByTestId("home-recommendations")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("home-recommendations").getByText("読み込み中…")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
}

// 収穫期の気温: 平年値の材料（3 年分）と出蕾の翌日〜昨日の実績、目標積算温度 100
async function prepareHarvestWindow(fieldId: string, budDate: string) {
  const supabase = await supabaseAsA();
  const rows: Record<string, unknown>[] = [];
  const row = (date: string, t: number) => ({ field_id: fieldId, date, t_mean: t, t_min: t - 5, t_max: t + 5, api: "archive" });
  for (const y of [2023, 2024, 2025]) for (const date of eachDate(`${y}-01-01`, `${y}-12-31`)) rows.push(row(date, 24));
  for (const date of eachDate(addDays(budDate, 1), addDays(today(), -1))) rows.push(row(date, 30));
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await supabase.from("weather_daily").insert(rows.slice(i, i + 1000));
    if (error) throw new Error(`weather_daily を入れられません: ${error.message}`);
  }
  const { error } = await supabase
    .from("field_cultivar_params")
    .upsert({ field_id: fieldId, cultivar_id: await dwarfNamwaId(), flowering_to_harvest_gdd: 100 }, { onConflict: "field_id,cultivar_id" });
  if (error) throw new Error(`予測の設定を入れられません: ${error.message}`);
}

test("完了条件 1: 出蕾から N 日たった茎に「袋掛け・摘蕾」の提案が出て、袋掛けを記録すると done になる", async ({ page }) => {
  const { field, code, stemId } = await setupStem("E2E提案袋掛け");
  const budDate = addDays(today(), -15); // N（既定 14 日）を過ぎている
  const due = addDays(budDate, 14);
  await openStem(page, stemId, code);
  expect(await recommendations(stemId)).toEqual([]);

  // 画面から出蕾を記録 → 同期の後の再計算で、袋掛けと摘蕾の提案が open で作られる
  await recordBudOnScreen(page, budDate);
  await expect.poll(async () => (await recommendations(stemId)).map((r) => [r.kind, r.status]), { timeout: ACTION_TIMEOUT }).toEqual([
    ["bag", "open"],
    ["debud", "open"],
  ]);
  const reason = `出蕾から 14 日（出蕾 ${md(budDate)}）`;
  for (const r of await recommendations(stemId)) {
    expect(r).toMatchObject({ due_at: due, reason, resolved_at: null, resolved_by: null, organization_id: ORG_A });
  }

  // ホームの「すべて見る」が必ず出るよう、ほかに提案を 4 件作る（2 本の茎 × 袋掛け・摘蕾）
  for (const seq of [2, 3]) {
    const other = await setupStem("", field, seq);
    await recordBudDirect(other.stemId, addDays(today(), -20));
    await recompute(page, other.stemId);
  }

  // 提案の一覧（ホームの「すべて見る」と同じ部品）: 行に対象（株コード・茎）、理由、期限、「実施した」「無視」
  await openList(page);
  const bagRow = homeRow(page, stemId, "bag");
  await expect(bagRow).toBeVisible();
  await expect(bagRow.getByTestId("recommendation-kind")).toHaveText("袋掛け");
  await expect(bagRow.getByTestId("recommendation-target")).toHaveText(`${code} 親`);
  await expect(bagRow.getByTestId("recommendation-reason")).toHaveText(reason);
  await expect(bagRow.getByTestId("recommendation-due")).toHaveText(`期限 ${md(due)}（1 日過ぎ）`);
  await expect(bagRow).toHaveAttribute("data-due-at", due);
  await expect(bagRow.getByTestId("recommendation-dismiss")).toHaveText("無視");
  await expect(homeRow(page, stemId, "debud").getByTestId("recommendation-kind")).toHaveText("摘蕾");

  // 「実施した」→ 茎の画面の袋掛けのダイアログが開く。開いたら URL から ?record= を外す（再読み込みで再び開かない）
  await bagRow.getByTestId("recommendation-done").click();
  const dialog = page.getByTestId("event-dialog");
  await expect(dialog).toHaveAttribute("data-type", "bagged", { timeout: ACTION_TIMEOUT });
  await expect(page).toHaveURL(`/stems/${stemId}`);
  await dialog.getByTestId("event-submit").click();
  await expect(view(page).getByTestId("event-notice")).toHaveText("袋掛けを記録しました", { timeout: ACTION_TIMEOUT });
  await waitForSynced(page);

  // 同期の後に自動で done（記録者・イベント・理由を残す）。摘蕾は open のまま
  const bagEvent = await eventId(stemId, "bagged");
  await expect.poll(async () => (await recommendations(stemId)).find((r) => r.kind === "bag")?.status, { timeout: ACTION_TIMEOUT }).toBe("done");
  const after = await recommendations(stemId);
  const bag = after.find((r) => r.kind === "bag")!;
  expect(bag).toMatchObject({ resolved_by: await userIdA(), resolution_note: "袋掛けを記録", resolved_event_id: bagEvent });
  expect(bag.resolved_at).not.toBeNull();
  expect(after.find((r) => r.kind === "debud")).toMatchObject({ status: "open" });

  // 下部タブの「ホーム」→「すべて見る」（どちらもクライアント遷移）→ 同じ茎の摘蕾の「実施した」でも、
  // 摘蕾のダイアログが開く（前に開いた茎の画面の状態が残っていても）
  await page.locator('[data-testid="bottom-nav"]:visible').getByTestId("nav-home").click();
  await expect(page).toHaveURL("/", { timeout: ACTION_TIMEOUT });
  await view(page).getByTestId("recommendations-all").click();
  await expect(page).toHaveURL("/recommendations", { timeout: ACTION_TIMEOUT });
  await homeRow(page, stemId, "debud").getByTestId("recommendation-done").click();
  await expect(page.getByTestId("event-dialog")).toHaveAttribute("data-type", "debudded", { timeout: ACTION_TIMEOUT });
  await expect(page).toHaveURL(`/stems/${stemId}`);

  // 「やめる」→ ブラウザの戻る → もう一度「実施した」でも開く（同じ値でもう一度来たとき）
  await page.getByTestId("event-dialog").getByTestId("event-cancel").click();
  await expect(page.getByTestId("event-dialog")).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL("/recommendations", { timeout: ACTION_TIMEOUT });
  await homeRow(page, stemId, "debud").getByTestId("recommendation-done").click();
  await expect(page.getByTestId("event-dialog")).toHaveAttribute("data-type", "debudded", { timeout: ACTION_TIMEOUT });
  await page.getByTestId("event-dialog").getByTestId("event-submit").click();
  await expect(view(page).getByTestId("event-notice")).toHaveText("摘蕾を記録しました", { timeout: ACTION_TIMEOUT });
  await waitForSynced(page);
  await expect.poll(async () => (await recommendations(stemId)).map((r) => [r.kind, r.status]), { timeout: ACTION_TIMEOUT }).toEqual([
    ["bag", "done"],
    ["debud", "done"],
  ]);

  // 再読み込みしてもダイアログは開かない（URL に ?record= が残っていない）
  await page.reload();
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(code, { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("event-dialog")).toHaveCount(0);

  // 一覧から両方の行が消える
  await openList(page);
  await expect(homeRow(page, stemId, "bag")).toHaveCount(0);
  await expect(homeRow(page, stemId, "debud")).toHaveCount(0);
});

test("ホームの「提案」は「今週見る株」の上に期限の近い 3 件。「すべて見る（N 件）」で全件の一覧へ（期限順）", async ({ page }) => {
  // 提案を 4 件以上にする（2 本の茎 × 袋掛け・摘蕾）
  const a = await setupStem("E2E提案一覧");
  const b = await setupStem("", a.field, 2);
  for (const s of [a, b]) {
    await recordBudDirect(s.stemId, addDays(today(), -20));
    await recompute(page, s.stemId);
  }
  await openHome(page);
  const section = view(page).getByTestId("home-recommendations");
  const sectionBox = await section.boundingBox();
  const weeklyBox = await view(page).getByTestId("home-weekly").boundingBox();
  expect(sectionBox!.y).toBeLessThan(weeklyBox!.y);
  await expect(section.getByTestId("recommendation-row")).toHaveCount(3);
  const homeDues = await section.getByTestId("recommendation-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-due-at") ?? ""));
  expect(homeDues).toEqual([...homeDues].sort());
  const all = section.getByTestId("recommendations-all");
  await expect(all).toHaveText(/^すべて見る（\d+ 件）$/);
  const total = Number((await all.textContent())!.match(/\d+/)![0]);
  expect(total).toBeGreaterThanOrEqual(4);

  await all.click();
  await expect(page).toHaveURL("/recommendations", { timeout: ACTION_TIMEOUT });
  const rows = view(page).getByTestId("recommendation-row");
  await expect(view(page).locator(`[data-testid="recommendation-row"][data-stem-id="${b.stemId}"][data-kind="debud"]`)).toBeVisible({
    timeout: ACTION_TIMEOUT,
  });
  expect(await rows.count()).toBeGreaterThanOrEqual(4);
  const dues = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-due-at") ?? ""));
  expect(dues).toEqual([...dues].sort());
  await expect(view(page).getByTestId("recommendations-all")).toHaveCount(0);
  await expect(page.locator('[data-testid="bottom-nav"]:visible')).toBeVisible();
});

test("完了条件 1（設定）: N は圃場ごとの設定。圃場の詳細で 7 日にすると、出蕾から 8 日の茎に提案が出る", async ({ page }) => {
  const { field, stemId } = await setupStem("E2E提案日数");
  const budDate = addDays(today(), -8);
  await recordBudDirect(stemId, budDate);
  // 既定の 14 日では出ない
  const first = await recompute(page, stemId);
  expect(first.recommendations).toMatchObject({ stems: 1, errors: [] });
  expect(await recommendations(stemId)).toEqual([]);

  await page.goto(`/fields/${field.id}`);
  const form = page.getByTestId("recommendation-params-form");
  await expect(form).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(form.getByTestId("recommendation-bag-after-days")).toHaveAttribute("placeholder", "14");
  // 範囲外はエラーで保存しない
  await form.getByTestId("recommendation-bag-after-days").fill("0");
  await form.getByTestId("recommendation-params-save").click();
  await expect(form.getByTestId("recommendation-bag-after-days-error")).toHaveText("袋掛け・摘蕾の日数は 1〜60 日の範囲で入力してください", {
    timeout: ACTION_TIMEOUT,
  });
  await form.getByTestId("recommendation-bag-after-days").fill("7");
  await form.getByTestId("recommendation-params-save").click();
  await expect(form.getByTestId("recommendation-params-saved")).toHaveText("保存しました", { timeout: ACTION_TIMEOUT });
  await expect(form.getByTestId("recommendation-bag-after-days")).toHaveValue("7");

  // 保存の後の再評価で、出蕾日 + 7 を期限に提案が出る
  const recs = await recommendations(stemId);
  expect(recs.map((r) => [r.kind, r.status, r.due_at, r.reason])).toEqual([
    ["bag", "open", addDays(budDate, 7), `出蕾から 7 日（出蕾 ${md(budDate)}）`],
    ["debud", "open", addDays(budDate, 7), `出蕾から 7 日（出蕾 ${md(budDate)}）`],
  ]);
  const supabase = await supabaseAsA();
  const { data: params } = await supabase.from("field_recommendation_params").select("bag_after_days, harvest_window_days, organization_id").eq("field_id", field.id).single();
  expect(params).toEqual({ bag_after_days: 7, harvest_window_days: null, organization_id: ORG_A });
});

test("完了条件 1（オフライン）: 圏外で記録した袋掛けも、同期の後に提案が done になる", async ({ page, context }) => {
  const { code, stemId } = await setupStem("E2E提案圏外");
  await recordBudDirect(stemId, addDays(today(), -20));
  await recompute(page, stemId);
  expect((await recommendations(stemId)).map((r) => r.status)).toEqual(["open", "open"]);

  await openStem(page, stemId, code);
  await waitForSynced(page);
  await context.setOffline(true);
  await view(page).getByTestId("event-button-bagged").click();
  await page.getByTestId("event-dialog").getByTestId("event-submit").click();
  await expect(view(page).getByTestId("event-notice")).toHaveText("袋掛けを記録しました", { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("sync-pending-count")).toHaveText("1", { timeout: ACTION_TIMEOUT });
  expect((await recommendations(stemId)).find((r) => r.kind === "bag")?.status).toBe("open");

  await context.setOffline(false);
  await waitForSynced(page);
  await expect.poll(async () => (await recommendations(stemId)).find((r) => r.kind === "bag")?.status, { timeout: ACTION_TIMEOUT }).toBe("done");
  expect((await recommendations(stemId)).find((r) => r.kind === "bag")).toMatchObject({
    resolved_event_id: await eventId(stemId, "bagged"),
    resolved_by: await userIdA(),
  });
});

test("完了条件 2: 予測の下限が 7 日以内の茎に「収穫期」の提案が出る。収穫を記録すると done、喪失すると dismissed", async ({ page }) => {
  const budDate = addDays(today(), -6);
  const a = await setupStem("E2E提案収穫期");
  const b = await setupStem("", a.field, 2);
  await prepareHarvestWindow(a.field.id, budDate);

  // 茎 a: 画面から出蕾を記録 → 同期の後に収穫予測（下限 = 今日）→ 収穫期の提案
  await openStem(page, a.stemId, a.code);
  await recordBudOnScreen(page, budDate);
  await expect(view(page).getByTestId("stem-harvest")).toHaveAttribute("data-lower-date", today(), { timeout: ACTION_TIMEOUT });
  await expect.poll(async () => (await recommendations(a.stemId)).map((r) => [r.kind, r.status]), { timeout: ACTION_TIMEOUT }).toEqual([
    ["harvest_window", "open"],
  ]);
  expect((await recommendations(a.stemId))[0]).toMatchObject({
    due_at: today(),
    reason: `積算温度が目安に近づいています（収穫予測の早い日 ${md(today())}）`,
  });

  // 茎 b: 出蕾（直接）→ 再計算で同じく収穫期
  await recordBudDirect(b.stemId, budDate);
  await recompute(page, b.stemId);
  expect((await recommendations(b.stemId)).map((r) => [r.kind, r.status])).toEqual([["harvest_window", "open"]]);

  // 提案の一覧に収穫期の行（期限 今日）
  await openList(page);
  const row = homeRow(page, a.stemId, "harvest_window");
  await expect(row.getByTestId("recommendation-kind")).toHaveText("収穫期");
  await expect(row.getByTestId("recommendation-target")).toHaveText(`${a.code} 親`);
  await expect(row.getByTestId("recommendation-due")).toHaveText(`期限 今日（${md(today())}）`);

  // 「実施した」→ 茎の画面の収穫のダイアログ → 記録 → done
  await row.getByTestId("recommendation-done").click();
  const dialog = page.getByTestId("event-dialog");
  await expect(dialog).toHaveAttribute("data-type", "harvested", { timeout: ACTION_TIMEOUT });
  await expect(page).toHaveURL(`/stems/${a.stemId}`);
  await dialog.getByTestId("event-weight-kg").fill("18");
  await dialog.getByTestId("event-submit").click();
  await expect(view(page).getByTestId("stem-status")).toHaveText("収穫済み", { timeout: ACTION_TIMEOUT });
  await waitForSynced(page);
  await expect.poll(async () => (await recommendations(a.stemId))[0]?.status, { timeout: ACTION_TIMEOUT }).toBe("done");
  expect((await recommendations(a.stemId))[0]).toMatchObject({
    resolution_note: "収穫を記録",
    resolved_event_id: await eventId(a.stemId, "harvested"),
    resolved_by: await userIdA(),
  });

  // 茎 b: 喪失（被害・喪失）を記録 → dismissed（理由「対象が終了」）
  await openStem(page, b.stemId, b.code);
  await view(page).getByTestId("event-button-damage").click();
  const damage = page.getByTestId("event-dialog");
  await damage.getByTestId("event-kind").selectOption("lodging");
  await damage.getByTestId("event-severity").selectOption("lost");
  await damage.getByTestId("event-submit").click();
  await expect(view(page).getByTestId("stem-status")).toHaveText("喪失", { timeout: ACTION_TIMEOUT });
  await waitForSynced(page);
  await expect.poll(async () => (await recommendations(b.stemId))[0]?.status, { timeout: ACTION_TIMEOUT }).toBe("dismissed");
  const lost = (await recommendations(b.stemId))[0];
  expect(lost).toMatchObject({ resolution_note: "対象が終了", resolved_event_id: await eventId(b.stemId, "damage"), resolved_by: await userIdA() });
  expect(lost.resolved_at).not.toBeNull();

  // 一覧からどちらの行も消える
  await openList(page);
  await expect(homeRow(page, a.stemId, "harvest_window")).toHaveCount(0);
  await expect(homeRow(page, b.stemId, "harvest_window")).toHaveCount(0);
});

test("完了条件 3: 同じ提案が二重にできない。「無視」は dismissed として残り、再び作られない", async ({ page, request }) => {
  const { field, code, stemId } = await setupStem("E2E提案無視");
  await recordBudDirect(stemId, addDays(today(), -20));

  // 再計算を何度呼んでも（同期後の再計算・日次の Cron）、袋掛け・摘蕾は 1 件ずつ
  await recompute(page, stemId);
  await recompute(page, stemId);
  const cron = await request.get(`/api/cron/weather?fieldId=${field.id}`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "e2e-weather-fault": "all" },
    timeout: 60_000,
  });
  expect(cron.status()).toBe(200);
  expect((await cron.json()).recommendations).toEqual([expect.objectContaining({ fieldId: field.id, created: 0, errors: [] })]);
  const recs = await recommendations(stemId);
  expect(recs.map((r) => [r.kind, r.status])).toEqual([
    ["bag", "open"],
    ["debud", "open"],
  ]);

  // DB でも二重を拒否する（同じ対象・同じ kind の 2 件目は unique 違反）
  const supabase = await supabaseAsA();
  const { error: dup } = await supabase
    .from("recommendations")
    .insert({ kind: "bag", target_type: "stem", target_id: stemId, due_at: today(), reason: "二重" });
  expect(dup?.code).toBe("23505");
  const { error: dupKey } = await supabase
    .from("recommendations")
    .insert({ kind: "bag", target_type: "stem", target_id: stemId, rule_key: "other", due_at: today(), reason: "二重（鍵違い）" });
  expect(dupKey?.code).toBe("23505");
  expect(await recommendations(stemId)).toHaveLength(2);

  // 一覧の「無視」→ 確認 → 一覧から消える
  await openList(page);
  const bagRow = homeRow(page, stemId, "bag");
  await bagRow.getByTestId("recommendation-dismiss").click();
  const dialog = page.getByTestId("recommendation-dismiss-dialog");
  await expect(dialog).toContainText(`${code} 親 の「袋掛け」`);
  await dialog.getByTestId("recommendation-dismiss-confirm").click();
  await expect(page.getByTestId("recommendation-dismiss-dialog")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(homeRow(page, stemId, "bag")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(homeRow(page, stemId, "debud")).toBeVisible();

  // dismissed として残る（resolved_at / resolved_by）
  const bag = (await recommendations(stemId)).find((r) => r.kind === "bag")!;
  expect(bag).toMatchObject({ status: "dismissed", resolution_note: "無視", resolved_by: await userIdA() });
  expect(bag.resolved_at).not.toBeNull();

  // 再計算・Cron を走らせても作り直されない（袋掛けは記録していないので条件は満たしたまま）
  const again = await recompute(page, stemId);
  expect(again.recommendations).toMatchObject({ created: 0, resolved: 0, errors: [] });
  await request.get(`/api/cron/weather?fieldId=${field.id}`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}`, "e2e-weather-fault": "all" },
    timeout: 60_000,
  });
  const final = await recommendations(stemId);
  expect(final.map((r) => [r.kind, r.status])).toEqual([
    ["bag", "dismissed"],
    ["debud", "open"],
  ]);
  await openList(page);
  await expect(homeRow(page, stemId, "bag")).toHaveCount(0);

  // 閉じた提案は開き直せず、消せない（0022）
  const { error: reopen } = await supabase.from("recommendations").update({ status: "open" }).eq("id", bag.id);
  expect(reopen).not.toBeNull();
  const { data: deleted } = await supabase.from("recommendations").delete().eq("id", bag.id).select("id");
  expect(deleted ?? []).toEqual([]);
  expect((await recommendations(stemId)).find((r) => r.id === bag.id)?.status).toBe("dismissed");
});

test.describe("他組織", () => {
  test.use({ storageState: AUTH_STATE_B });

  test("テスト農園 B からは A の提案と設定が見えず、閉じられず、再計算でも作られない", async ({ page }) => {
    const { field, stemId } = await setupStem("E2E提案他組織");
    await recordBudDirect(stemId, addDays(today(), -20));
    const b = await supabaseAsB();

    // B の権限で再計算を呼んでも A の茎は見えない（提案は作られない）
    const res = await page.request.post("/api/predictions/recompute", { data: { stemId } });
    expect(await res.json()).toMatchObject({ ok: true, recommendations: { stems: 0, created: 0 } });
    expect(await recommendations(stemId)).toEqual([]);

    // A の提案（A のクライアントで作る）は B から見えず、閉じられない
    const a = await supabaseAsA();
    const { data: made, error } = await a
      .from("recommendations")
      .insert({ kind: "bag", target_type: "stem", target_id: stemId, due_at: today(), reason: "A の提案" })
      .select("id")
      .single();
    expect(error).toBeNull();
    const { data: seen } = await b.from("open_recommendations").select("id").eq("id", made!.id);
    expect(seen).toEqual([]);
    const { data: closed } = await b.from("recommendations").update({ status: "dismissed" }).eq("id", made!.id).select("id");
    expect(closed ?? []).toEqual([]);
    expect((await recommendations(stemId))[0]).toMatchObject({ status: "open" });
    // B から A の茎に提案を作れない
    const { error: insertError } = await b.from("recommendations").insert({ kind: "debud", target_type: "stem", target_id: stemId });
    expect(insertError).not.toBeNull();
    // 設定も見えない
    const { data: params } = await b.from("field_recommendation_params").select("field_id").eq("field_id", field.id);
    expect(params).toEqual([]);

    // B の提案の一覧に A の提案は出ない
    await openList(page);
    await expect(homeRow(page, stemId, "bag")).toHaveCount(0);
  });
});
