import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, supabaseAsA, test, waitForSynced } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";

// 1-8 イベントの記録（出蕾・袋掛け・収穫・被害）。完了条件 1〜3 を 1 つずつ検証し、加えて
// 出蕾前の袋掛けの拒否、被害「喪失」以外で状態が変わらないこと、履歴に累計葉数が出ることを検証する。
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。テストごとにログインしない。
// 圃場の名前は E2E で始める。観測・イベントを持つ茎は消せないので、圃場はワーカーごとに 1 つだけ作り、テストごとに株を分ける。

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let sharedField: Awaited<ReturnType<typeof createField>>;
let matSeq = 0;

test.beforeAll(async () => {
  sharedField = await createField("E2Eイベント");
});

async function setupStem(status: "active" | "flowered" = "active", initialLeafCount = 4) {
  matSeq += 1;
  const code = `${sharedField.code}-${String(matSeq).padStart(3, "0")}`;
  const matId = await createMat(sharedField.id, code);
  const stemId = await createStem(matId, { initialLeafCount, status });
  return { code, matId, stemId };
}

// 観測を DB に直接入れる（+1 の UI は 1-6 で検証済み）
async function insertLeavesNew(stemId: string, value: number, observedAt: string) {
  const supabase = await supabaseAsA();
  const { error } = await supabase.from("observations").insert({ stem_id: stemId, type: "leaves_new", value, observed_at: observedAt });
  if (error) throw new Error(`観測を作れません: ${error.message}`);
}

async function stemRow(stemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("stems")
    .select("id, status, bud_emerged_at, bagged_at, harvested_at, ended_at")
    .eq("id", stemId)
    .single();
  if (error) throw new Error(`茎を取得できません: ${error.message}`);
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

async function observationRows(stemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("observations")
    .select("id, type, value, observed_at, observed_by")
    .eq("stem_id", stemId)
    // 出蕾の生葉数と周囲長は同じ observed_at なので、type（enum の宣言順: leaves_new < leaves_current < pseudostem_girth_cm）
    // を 2 番目の並びにして順序を決める（同時刻の並びは保証されないため）
    .order("observed_at")
    .order("type");
  if (error) throw new Error(`観測を取得できません: ${error.message}`);
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

// 今日（日本時間、YYYY-MM-DD）。RPC は occurred_at を Asia/Tokyo の日付にして stems の日付列に入れる
const todayJst = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// クライアント側の遷移では前の画面の <main> が DOM に残るので、表示中の <main> に絞る
const view = (page: Page) => page.locator("main:visible");

async function openStem(page: Page, stemId: string, matCode: string) {
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(matCode);
}

async function eventButtons(page: Page) {
  return view(page).getByTestId("event-buttons").locator("button").allTextContents();
}

test("1. 出蕾を記録すると状態が「出蕾済み」になり、その時点の累計葉数がイベントに保存される", async ({ page }) => {
  const { code, matId, stemId } = await setupStem("active", 4);
  // 累計 = 4 + 1 + 2 = 7。直近の観測日は 2026-10-15（JST）
  await insertLeavesNew(stemId, 1, "2026-10-01T03:00:00Z");
  await insertLeavesNew(stemId, 2, "2026-10-15T03:00:00Z");

  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("stem-status")).toHaveText("栽培中");
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("7");
  // 栽培中（active）のボタンは 出蕾・被害 だけ（袋掛け・収穫などは出蕾前には出ない）
  expect(await eventButtons(page)).toEqual(["出蕾", "被害"]);

  // 出蕾 → ダイアログ（確認を挟む）。確認日の既定は今日、前回訪問日の既定は直近の観測日
  await view(page).getByTestId("event-button-bud_emerged").click();
  const dialog = page.getByTestId("event-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-type", "bud_emerged");
  await expect(dialog.getByTestId("event-date")).toHaveValue(todayJst());
  await expect(dialog.getByTestId("event-earliest-at")).toHaveValue("2026-10-15");

  // 「やめる」→ 記録されない
  await dialog.getByTestId("event-cancel").click();
  await expect(page.getByTestId("event-dialog")).toHaveCount(0);
  expect(await eventRows(stemId)).toHaveLength(0);

  // 生葉数が空なら理由を表示して記録しない
  await view(page).getByTestId("event-button-bud_emerged").click();
  await dialog.getByTestId("event-girth-cm").fill("45.5");
  await dialog.getByTestId("event-submit").click();
  await expect(dialog.getByTestId("event-error")).toHaveText("生葉数を入力してください", { timeout: ACTION_TIMEOUT });
  expect(await eventRows(stemId)).toHaveLength(0);
  // エラー後も入力した周囲長は残る（フォームが既定値に戻らない）
  await expect(dialog.getByTestId("event-girth-cm")).toHaveValue("45.5");

  // 過去日（確認日 2026-10-20、前回訪問日 2026-10-12）と生葉数 10 を入れ、周囲長を空にして送信 → エラー。
  // エラー後も確認日・前回訪問日・生葉数が入力値のまま残る（今日や既定値に戻らない）
  await dialog.getByTestId("event-date").fill("2026-10-20");
  await dialog.getByTestId("event-earliest-at").fill("2026-10-12");
  await dialog.getByTestId("event-leaves-current").fill("10");
  await dialog.getByTestId("event-girth-cm").fill("");
  await dialog.getByTestId("event-submit").click();
  await expect(dialog.getByTestId("event-error")).toHaveText("偽茎周囲長を入力してください", { timeout: ACTION_TIMEOUT });
  expect(await eventRows(stemId)).toHaveLength(0);
  await expect(dialog.getByTestId("event-date")).toHaveValue("2026-10-20");
  await expect(dialog.getByTestId("event-earliest-at")).toHaveValue("2026-10-12");
  await expect(dialog.getByTestId("event-leaves-current")).toHaveValue("10");

  // 不足していた周囲長 45.5 だけ入れて確定（他の項目は入れ直さない）
  await dialog.getByTestId("event-girth-cm").fill("45.5");
  await dialog.getByTestId("event-submit").click();
  await expect(view(page).getByTestId("event-notice")).toHaveText("出蕾を記録しました", { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("event-dialog")).toHaveCount(0);

  // ヘッダの状態が「出蕾済み」。ボタンは flowered 用（段数・袋掛け・摘蕾・収穫・被害）に変わり、出蕾は出ない
  await expect(view(page).getByTestId("stem-status")).toHaveText("出蕾済み");
  expect(await eventButtons(page)).toEqual(["段数", "袋掛け", "摘蕾", "収穫", "被害"]);
  // 葉数の記録ボタンは出蕾後も出る（flowered は栽培中の一部）
  await expect(view(page).getByTestId("leaves-new-1")).toBeVisible();

  // 履歴: 出蕾（累計葉数 7・生葉数 10・周囲長 45.5）と、観測としての生葉数・周囲長
  const budItem = view(page).locator('[data-testid="history-item"][data-type="bud_emerged"]');
  await expect(budItem).toHaveCount(1);
  await expect(budItem.getByTestId("history-label")).toHaveText("出蕾");
  await expect(budItem.getByTestId("history-value")).toHaveText("累計葉数 7 枚・生葉数 10 枚・周囲長 45.5 cm");
  // 履歴の日付は入力した過去日（エラー後も日付が保持されていた）
  await expect(budItem.getByTestId("history-at")).toContainText("2026/10/20");
  await expect(view(page).locator('[data-testid="history-item"][data-type="leaves_current"]').getByTestId("history-value")).toHaveText("10 枚");
  await expect(view(page).locator('[data-testid="history-item"][data-type="pseudostem_girth_cm"]').getByTestId("history-value")).toHaveText(
    "45.5 cm",
  );
  // 検算: 生葉数 10 は累計 7 と 3 枚ずれるので警告が出る（出蕾の生葉数が検算に使われている）
  await expect(view(page).getByTestId("stem-leaves-by-check")).toHaveText("10 枚");

  // DB: events に bud_emerged、payload にその時点の累計葉数 7 と入力値（生葉数 10・前回訪問日 2026-10-12）。
  // occurred_at は入力した過去日（JST の 0 時）。stems は flowered、bud_emerged_at = 2026-10-20（今日ではない）
  // （記録は端末の outbox 経由で送られるので、同期が終わるのを待ってから確かめる）
  await waitForSynced(page);
  const events = await eventRows(stemId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "bud_emerged",
    target_type: "stem",
    target_id: stemId,
    recorded_by: await profileIdA(),
    payload: { cumulative_leaves: 7, leaves_current: 10, girth_cm: 45.5, earliest_at: "2026-10-12" },
    organization_id: ORG_A,
    superseded_by: null,
  });
  expect(new Date(events[0].occurred_at).toISOString()).toBe(new Date("2026-10-20T00:00:00+09:00").toISOString());
  expect(await stemRow(stemId)).toMatchObject({ status: "flowered", bud_emerged_at: "2026-10-20", harvested_at: null, ended_at: null });
  const obs = await observationRows(stemId);
  expect(obs.map((o) => [o.type, Number(o.value)])).toEqual([
    ["leaves_new", 1],
    ["leaves_new", 2],
    ["leaves_current", 10],
    ["pseudostem_girth_cm", 45.5],
  ]);
  expect(obs[2].observed_at).toBe(obs[3].observed_at);
  expect(new Date(obs[2].observed_at).toISOString()).toBe(new Date(events[0].occurred_at).toISOString());

  // 再読み込み後も出蕾済み。株の詳細の茎一覧も「出蕾済み」
  await page.reload();
  await expect(view(page).getByTestId("stem-status")).toHaveText("出蕾済み");
  await page.goto(`/mats/${matId}`);
  await expect(view(page).getByTestId("stem-item").first().getByTestId("stem-status")).toHaveText("出蕾済み");
  await expect(view(page).getByTestId("stem-item").first()).toHaveAttribute("data-status", "flowered");
});

test("1b. 出蕾前（栽培中）には袋掛けできない: ボタンが出ず、RPC を直接呼んでも日本語の理由で拒否される", async ({ page }) => {
  const { code, stemId } = await setupStem("active", 3);
  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("event-button-bud_emerged")).toBeVisible();
  await expect(view(page).getByTestId("event-button-bagged")).toHaveCount(0);
  await expect(view(page).getByTestId("event-button-harvested")).toHaveCount(0);
  await expect(view(page).getByTestId("event-button-hands_counted")).toHaveCount(0);

  // DB の正本: RPC は状態の前提を検査し、同一トランザクションなのでイベントも入らない
  const supabase = await supabaseAsA();
  for (const [type, label] of [
    ["bagged", "袋掛け"],
    ["harvested", "収穫"],
    ["hands_counted", "段数"],
    ["debudded", "摘蕾"],
  ] as const) {
    const { error } = await supabase.rpc("record_stem_event", {
      p_id: crypto.randomUUID(),
      p_stem_id: stemId,
      p_type: type,
      p_occurred_at: new Date().toISOString(),
      p_payload: type === "harvested" ? { weight_kg: 10 } : type === "hands_counted" ? { hands: 8 } : {},
      p_note: null,
    });
    expect(error?.message).toContain(`${label}は出蕾済みの茎にだけ記録できます`);
  }
  // 出蕾済みの茎に出蕾はできない。この関数で扱わない type（枯葉処理）も拒否
  const flowered = await setupStem("flowered", 3);
  const { error: budError } = await supabase.rpc("record_stem_event", {
    p_id: crypto.randomUUID(),
    p_stem_id: flowered.stemId,
    p_type: "bud_emerged",
    p_occurred_at: new Date().toISOString(),
    p_payload: { cumulative_leaves: 3, leaves_current: 3, girth_cm: 30, earliest_at: null },
    p_note: null,
  });
  expect(budError?.message).toContain("出蕾は栽培中の茎にだけ記録できます");
  const { error: otherError } = await supabase.rpc("record_stem_event", {
    p_id: crypto.randomUUID(),
    p_stem_id: stemId,
    p_type: "leaves_removed",
    p_occurred_at: new Date().toISOString(),
    p_payload: { count: 1 },
    p_note: null,
  });
  expect(otherError?.message).toContain("この関数では記録できません");
  expect(await eventRows(stemId)).toHaveLength(0);
  expect(await eventRows(flowered.stemId)).toHaveLength(0);
  expect((await stemRow(stemId)).status).toBe("active");
});

test("2. 収穫を記録すると状態が「収穫済み」になり、その茎には記録ボタンが出ない（履歴へのリンクだけ）", async ({ page }) => {
  const { code, matId, stemId } = await setupStem("flowered", 12);
  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("stem-status")).toHaveText("出蕾済み");
  expect(await eventButtons(page)).toEqual(["段数", "袋掛け", "摘蕾", "収穫", "被害"]);

  // 収穫 → ダイアログ。重量が 0 なら理由を表示して記録しない
  await view(page).getByTestId("event-button-harvested").click();
  const dialog = page.getByTestId("event-dialog");
  await expect(dialog).toHaveAttribute("data-type", "harvested");
  await expect(dialog.getByTestId("event-date")).toHaveValue(todayJst());
  // 過去日 2026-10-18 に変えて重量 0 で送信 → エラー。エラー後も日付と重量は入力値のまま（今日に戻らない）
  await dialog.getByTestId("event-date").fill("2026-10-18");
  await dialog.getByTestId("event-weight-kg").fill("0");
  await dialog.getByTestId("event-submit").click();
  await expect(dialog.getByTestId("event-error")).toContainText("果房重量", { timeout: ACTION_TIMEOUT });
  expect(await eventRows(stemId)).toHaveLength(0);
  await expect(dialog.getByTestId("event-date")).toHaveValue("2026-10-18");
  await expect(dialog.getByTestId("event-weight-kg")).toHaveValue("0");

  // 重量だけ 12.5 kg に直して確定（日付は入れ直さない）
  await dialog.getByTestId("event-weight-kg").fill("12.5");
  await dialog.getByTestId("event-submit").click();

  // 状態「収穫済み」。記録ボタン（葉数・枯葉・現在の葉数・写真・イベント）が無く、履歴へのリンクはある
  await expect(view(page).getByTestId("stem-status")).toHaveText("収穫済み", { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("event-dialog")).toHaveCount(0);
  await expect(view(page).getByTestId("record-closed")).toContainText("収穫済みのため記録できません");
  await expect(view(page).getByTestId("leaves-new-1")).toHaveCount(0);
  await expect(view(page).getByTestId("leaves-removed-submit")).toHaveCount(0);
  await expect(view(page).getByTestId("leaves-current-submit")).toHaveCount(0);
  await expect(view(page).getByTestId("photo-input")).toHaveCount(0);
  await expect(view(page).getByTestId("event-section")).toHaveCount(0);
  await expect(view(page).locator('[data-testid^="event-button-"]')).toHaveCount(0);
  await expect(view(page).getByTestId("stem-history-link")).toBeVisible();
  // 履歴に「収穫 12.5 kg」
  const item = view(page).locator('[data-testid="history-item"][data-type="harvested"]');
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId("history-label")).toHaveText("収穫");
  await expect(item.getByTestId("history-value")).toHaveText("12.5 kg");
  await expect(item.getByTestId("history-at")).toContainText("2026/10/18");

  // DB: stems は harvested、harvested_at = ended_at = 入力した過去日 2026-10-18。events に harvested（weight_kg: 12.5）
  await waitForSynced(page);
  expect(await stemRow(stemId)).toMatchObject({ status: "harvested", harvested_at: "2026-10-18", ended_at: "2026-10-18" });
  const events = await eventRows(stemId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "harvested", payload: { weight_kg: 12.5 }, organization_id: ORG_A, recorded_by: await profileIdA() });

  // 再読み込み後も記録ボタンが無い。履歴画面からも戻れる。株の詳細の茎一覧は「収穫済み」
  await page.reload();
  await expect(view(page).getByTestId("record-closed")).toBeVisible();
  await expect(view(page).locator('[data-testid^="event-button-"]')).toHaveCount(0);
  await view(page).getByTestId("stem-history-link").click();
  await expect(page).toHaveURL(`/stems/${stemId}/history`, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-status")).toHaveText("収穫済み");
  await expect(view(page).locator('[data-testid="history-item"][data-type="harvested"]')).toHaveCount(1);
  await page.goto(`/mats/${matId}`);
  await expect(view(page).getByTestId("stem-item").first().getByTestId("stem-status")).toHaveText("収穫済み");
});

test("2b. 段数・袋掛け・摘蕾は状態を変えず、履歴に出る（袋掛けは bagged_at に入る）", async ({ page }) => {
  const { code, stemId } = await setupStem("flowered", 12);
  await openStem(page, stemId, code);
  const dialog = page.getByTestId("event-dialog");

  // 段数 8（0 は拒否）
  await view(page).getByTestId("event-button-hands_counted").click();
  await dialog.getByTestId("event-hands").fill("0");
  await dialog.getByTestId("event-submit").click();
  await expect(dialog.getByTestId("event-error")).toHaveText("段数は 1 以上の整数で入力してください", { timeout: ACTION_TIMEOUT });
  await dialog.getByTestId("event-hands").fill("8");
  await dialog.getByTestId("event-submit").click();
  await expect(view(page).getByTestId("event-notice")).toHaveText("段数を記録しました", { timeout: ACTION_TIMEOUT });

  // 袋掛け（過去日 2026-10-10）: 日付だけ。ダイアログで確認して「記録する」
  await view(page).getByTestId("event-button-bagged").click();
  await expect(dialog).toContainText("袋掛けを記録します。よろしいですか？");
  await dialog.getByTestId("event-date").fill("2026-10-10");
  await dialog.getByTestId("event-submit").click();
  await expect(view(page).getByTestId("event-notice")).toHaveText("袋掛けを記録しました", { timeout: ACTION_TIMEOUT });

  // 摘蕾
  await view(page).getByTestId("event-button-debudded").click();
  await dialog.getByTestId("event-submit").click();
  await expect(view(page).getByTestId("event-notice")).toHaveText("摘蕾を記録しました", { timeout: ACTION_TIMEOUT });

  // 状態は出蕾済みのまま。ボタンも変わらない
  await expect(view(page).getByTestId("stem-status")).toHaveText("出蕾済み");
  expect(await eventButtons(page)).toEqual(["段数", "袋掛け", "摘蕾", "収穫", "被害"]);
  // 履歴（新しい順）: 摘蕾 / 段数 8 段 / 袋掛け（2026-10-10 は古いので最後）
  const labels = await view(page).getByTestId("history-item").getByTestId("history-label").allTextContents();
  expect(labels).toEqual(["摘蕾", "段数", "袋掛け"]);
  await expect(view(page).locator('[data-testid="history-item"][data-type="hands_counted"]').getByTestId("history-value")).toHaveText("8 段");
  await expect(view(page).locator('[data-testid="history-item"][data-type="bagged"]').getByTestId("history-at")).toContainText("2026/10/10");

  await waitForSynced(page);
  expect(await stemRow(stemId)).toMatchObject({ status: "flowered", bagged_at: "2026-10-10", harvested_at: null, ended_at: null });
  const events = await eventRows(stemId);
  expect(events.map((e) => [e.type, e.payload])).toEqual([
    ["bagged", {}],
    ["hands_counted", { hands: 8 }],
    ["debudded", {}],
  ]);
});

test("3. 被害を「喪失」で記録すると状態が「喪失」になり、記録ボタンが消える", async ({ page }) => {
  const { code, matId, stemId } = await setupStem("active", 5);
  await openStem(page, stemId, code);

  await view(page).getByTestId("event-button-damage").click();
  const dialog = page.getByTestId("event-dialog");
  await expect(dialog).toHaveAttribute("data-type", "damage");
  // 種類を選ばないと記録できない
  await dialog.getByTestId("event-severity").selectOption("lost");
  await dialog.getByTestId("event-submit").click();
  await expect(dialog.getByTestId("event-error")).toHaveText("被害の種類を選んでください", { timeout: ACTION_TIMEOUT });
  expect(await eventRows(stemId)).toHaveLength(0);
  // エラー後も選んだ程度は残る
  await expect(dialog.getByTestId("event-severity")).toHaveValue("lost");

  // 種類（倒伏）だけ選んで確定（程度は選び直さない）
  await dialog.getByTestId("event-kind").selectOption("lodging");
  await dialog.getByTestId("event-submit").click();

  await expect(view(page).getByTestId("stem-status")).toHaveText("喪失", { timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("event-dialog")).toHaveCount(0);
  await expect(view(page).getByTestId("record-closed")).toContainText("喪失のため記録できません");
  await expect(view(page).getByTestId("leaves-new-1")).toHaveCount(0);
  await expect(view(page).locator('[data-testid^="event-button-"]')).toHaveCount(0);
  await expect(view(page).getByTestId("stem-history-link")).toBeVisible();
  const item = view(page).locator('[data-testid="history-item"][data-type="damage"]');
  await expect(item.getByTestId("history-label")).toHaveText("被害");
  await expect(item.getByTestId("history-value")).toHaveText("倒伏・喪失");

  await waitForSynced(page);
  expect(await stemRow(stemId)).toMatchObject({ status: "lost", ended_at: todayJst(), harvested_at: null });
  const events = await eventRows(stemId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "damage", payload: { kind: "lodging", severity: "lost" }, organization_id: ORG_A });

  // 株の詳細の茎一覧も「喪失」
  await page.goto(`/mats/${matId}`);
  await expect(view(page).getByTestId("stem-item").first().getByTestId("stem-status")).toHaveText("喪失");
  await expect(view(page).getByTestId("stem-item").first()).toHaveAttribute("data-status", "lost");
});

test("3b. 被害が「喪失」以外（軽）なら状態は変わらず、記録ボタンも残る", async ({ page }) => {
  const { code, stemId } = await setupStem("flowered", 9);
  await openStem(page, stemId, code);

  await view(page).getByTestId("event-button-damage").click();
  const dialog = page.getByTestId("event-dialog");
  await dialog.getByTestId("event-kind").selectOption("leaf_tear");
  await dialog.getByTestId("event-severity").selectOption("light");
  await dialog.getByTestId("event-submit").click();
  await expect(view(page).getByTestId("event-notice")).toHaveText("被害を記録しました", { timeout: ACTION_TIMEOUT });

  await expect(view(page).getByTestId("stem-status")).toHaveText("出蕾済み");
  expect(await eventButtons(page)).toEqual(["段数", "袋掛け", "摘蕾", "収穫", "被害"]);
  await expect(view(page).getByTestId("leaves-new-1")).toBeVisible();
  await expect(view(page).getByTestId("record-closed")).toHaveCount(0);
  const item = view(page).locator('[data-testid="history-item"][data-type="damage"]');
  await expect(item.getByTestId("history-value")).toHaveText("裂葉・軽");

  await waitForSynced(page);
  expect(await stemRow(stemId)).toMatchObject({ status: "flowered", ended_at: null });
  const events = await eventRows(stemId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "damage", payload: { kind: "leaf_tear", severity: "light" } });

  // 同じ茎に重（severe）を記録しても状態は変わらない
  await view(page).getByTestId("event-button-damage").click();
  await dialog.getByTestId("event-kind").selectOption("cold");
  await dialog.getByTestId("event-severity").selectOption("severe");
  await dialog.getByTestId("event-submit").click();
  await expect(view(page).locator('[data-testid="history-item"][data-type="damage"]')).toHaveCount(2, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-status")).toHaveText("出蕾済み");
  await waitForSynced(page);
  expect((await stemRow(stemId)).status).toBe("flowered");
});

test("4. 記録を編集・削除する UI がない（イベントを記録した後も）", async ({ page }) => {
  const { code, stemId } = await setupStem("flowered", 9);
  await openStem(page, stemId, code);
  await view(page).getByTestId("event-button-bagged").click();
  await page.getByTestId("event-dialog").getByTestId("event-submit").click();
  await expect(view(page).getByTestId("event-notice")).toHaveText("袋掛けを記録しました", { timeout: ACTION_TIMEOUT });
  await waitForSynced(page);

  for (const url of [`/stems/${stemId}`, `/stems/${stemId}/history`]) {
    await page.goto(url);
    await expect(view(page).getByTestId("history-item")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /削除|編集|訂正/ })).toHaveCount(0);
    await expect(view(page).getByTestId("history-item").locator("button, a, input, select, textarea")).toHaveCount(0);
  }
  // DB の正本: イベントは削除できず、superseded_by 以外は更新できない
  const supabase = await supabaseAsA();
  const events = await eventRows(stemId);
  const { error: delError, count } = await supabase.from("events").delete({ count: "exact" }).eq("id", events[0].id);
  expect(delError === null ? count : -1).toBe(0);
  const { error: updError } = await supabase.from("events").update({ payload: { x: 1 } }).eq("id", events[0].id);
  expect(updError?.message ?? "").toContain("append-only");
  expect(await eventRows(stemId)).toHaveLength(1);
});
