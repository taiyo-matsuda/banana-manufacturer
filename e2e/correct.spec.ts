import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, supabaseAsA, test, waitForSynced } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";

// 2-6 記録の訂正。完了条件 1〜3 を 1 つずつ検証し、加えて
// 同じ行の 2 回目の訂正の拒否（最新の行なら訂正できる）、出蕾日の訂正で stems.bud_emerged_at が変わること、
// 収穫の訂正で状態が収穫済みのままであること、出蕾前の +1 の訂正で「出蕾時の累計（記録）/ 現在の計算」が両方出ること、
// オフライン・未同期では訂正ボタンが無効であること、訂正した行も E2E の掃除（0006）で消えることを検証する。
// テスト農園 A でログイン済み（setup プロジェクトが保存した storageState）。テストごとにログインしない。
// 圃場の名前は E2E で始める。観測・イベントを持つ茎は消せないので、圃場はワーカーごとに 1 つだけ作り、テストごとに株を分ける。

let sharedField: Awaited<ReturnType<typeof createField>>;
let matSeq = 0;

test.beforeAll(async () => {
  sharedField = await createField("E2E訂正");
});

async function setupStem(status: "active" | "flowered" = "active", initialLeafCount = 5) {
  matSeq += 1;
  const code = `${sharedField.code}-${String(matSeq).padStart(3, "0")}`;
  const matId = await createMat(sharedField.id, code);
  const stemId = await createStem(matId, { initialLeafCount, status });
  return { code, matId, stemId };
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

// 茎のイベントを RPC で記録する（イベントの記録 UI は 1-8 で検証済み）
async function recordEvent(stemId: string, type: string, occurredAt: string, payload: Record<string, unknown>) {
  const supabase = await supabaseAsA();
  const id = crypto.randomUUID();
  const { error } = await supabase.rpc("record_stem_event", {
    p_id: id,
    p_stem_id: stemId,
    p_type: type,
    p_occurred_at: occurredAt,
    p_payload: payload,
  });
  if (error) throw new Error(`イベントを記録できません: ${error.message}`);
  return id;
}

async function observationRows(stemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("observations")
    .select("id, type, value, observed_at, superseded_by, organization_id")
    .eq("stem_id", stemId)
    .order("created_at");
  if (error) throw new Error(`観測を取得できません: ${error.message}`);
  return data!;
}

async function eventRows(stemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("events")
    .select("id, type, occurred_at, payload, superseded_by, organization_id")
    .eq("target_type", "stem")
    .eq("target_id", stemId)
    .order("created_at");
  if (error) throw new Error(`イベントを取得できません: ${error.message}`);
  return data!;
}

async function stemRow(stemId: string) {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("stems")
    .select("status, bud_emerged_at, harvested_at, ended_at")
    .eq("id", stemId)
    .single();
  if (error) throw new Error(`茎を取得できません: ${error.message}`);
  return data!;
}

const jst = (d: Date) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const todayJst = () => jst(new Date());
const daysAgoJst = (n: number) => jst(new Date(Date.now() - n * 86_400_000));

// クライアント側の遷移では前の画面の <main> が DOM に残るので、表示中の <main> に絞る
const view = (page: Page) => page.locator("main:visible");
const row = (page: Page, id: string) => view(page).locator(`[data-testid="history-item"][data-id="${id}"]`);

async function openStem(page: Page, stemId: string, matCode: string) {
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(matCode);
}

// 行の「訂正」を開いてダイアログを返す
async function openCorrection(page: Page, id: string) {
  await row(page, id).getByTestId("correct-open").click();
  const dialog = page.getByTestId("correct-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("1. +1 の観測を +2 に訂正すると累計葉数が 1 増え、履歴に元の行が「訂正済み」で残る", async ({ page }) => {
  const { code, stemId } = await setupStem("active", 5);
  const oldId = await insertLeavesNew(stemId, 1, `${daysAgoJst(2)}T09:00:00+09:00`);

  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("6");

  const dialog = await openCorrection(page, oldId);
  await expect(dialog).toHaveAttribute("data-type", "leaves_new");
  // 元の値と日付が初期値
  await expect(dialog.getByTestId("correct-value")).toHaveValue("1");
  await expect(dialog.getByTestId("correct-date")).toHaveValue(daysAgoJst(2));
  // 元と同じでは訂正しない（入力は残る）
  await dialog.getByTestId("correct-submit").click();
  await expect(dialog.getByTestId("correct-error")).toContainText("元の記録と同じです");
  await dialog.getByTestId("correct-value").fill("2");
  await dialog.getByTestId("correct-submit").click();
  await expect(page.getByTestId("correct-dialog")).toHaveCount(0, { timeout: ACTION_TIMEOUT });

  // 累計葉数 = 5 + 2（訂正済みの +1 は数えない）
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("7", { timeout: ACTION_TIMEOUT });

  // DB: 新しい行が追加され、元の行の superseded_by が新しい行を指す。値・日時は元の行のまま
  const rows = await observationRows(stemId);
  expect(rows).toHaveLength(2);
  const [oldRow, newRow] = rows;
  expect(oldRow).toMatchObject({ id: oldId, superseded_by: newRow.id });
  expect(Number(oldRow.value)).toBe(1);
  expect(newRow).toMatchObject({ type: "leaves_new", superseded_by: null, organization_id: oldRow.organization_id });
  expect(Number(newRow.value)).toBe(2);
  expect(new Date(newRow.observed_at).getTime()).toBe(new Date(oldRow.observed_at).getTime());

  // 記録入力と履歴の両方で、元の行は打ち消し線＋「訂正済み → +2」、新しい行には「訂正」の印
  for (const url of [`/stems/${stemId}`, `/stems/${stemId}/history`]) {
    await page.goto(url);
    await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("7");
    await expect(view(page).getByTestId("history-item")).toHaveCount(2);
    const old = row(page, oldId);
    await expect(old).toHaveAttribute("data-superseded", "true");
    await expect(old.getByTestId("history-value")).toHaveText("+1");
    await expect(old.getByTestId("history-value")).toHaveCSS("text-decoration-line", "line-through");
    await expect(old.getByTestId("history-superseded")).toHaveText("訂正済み → +2");
    // 訂正済みの行には訂正ボタンがない
    await expect(old.getByTestId("correct-open")).toHaveCount(0);
    const next = row(page, newRow.id);
    await expect(next).toHaveAttribute("data-correction", "true");
    await expect(next.getByTestId("history-value")).toHaveText("+2");
    await expect(next.getByTestId("history-correction")).toHaveText("訂正");
    await expect(next.getByTestId("correct-open")).toBeEnabled();
  }
});

test("2. 収穫の重量を訂正すると新しい重量が表示され、元の行は残る。状態は収穫済みのまま", async ({ page }) => {
  const { code, stemId } = await setupStem("flowered", 5);
  const oldId = await recordEvent(stemId, "harvested", `${daysAgoJst(1)}T00:00:00+09:00`, { weight_kg: 12.3 });
  expect(await stemRow(stemId)).toMatchObject({ status: "harvested", harvested_at: daysAgoJst(1) });

  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("stem-status")).toHaveText("収穫済み");
  await expect(row(page, oldId).getByTestId("history-value")).toHaveText("12.3 kg");

  const dialog = await openCorrection(page, oldId);
  await expect(dialog.getByTestId("correct-weight-kg")).toHaveValue("12.3");
  // 不正な値は理由を出して保存しない（入力は残る）
  await dialog.getByTestId("correct-weight-kg").fill("0");
  await dialog.getByTestId("correct-submit").click();
  await expect(dialog.getByTestId("correct-error")).toContainText("果房重量");
  await expect(dialog.getByTestId("correct-weight-kg")).toHaveValue("0");
  await dialog.getByTestId("correct-weight-kg").fill("13.5");
  await dialog.getByTestId("correct-submit").click();
  await expect(page.getByTestId("correct-dialog")).toHaveCount(0, { timeout: ACTION_TIMEOUT });

  const events = await eventRows(stemId);
  expect(events).toHaveLength(2);
  const [oldEv, newEv] = events;
  expect(oldEv).toMatchObject({ id: oldId, type: "harvested", payload: { weight_kg: 12.3 }, superseded_by: newEv.id });
  expect(newEv).toMatchObject({ type: "harvested", payload: { weight_kg: 13.5 }, superseded_by: null });
  // 状態は収穫済みのまま（日付は変えていないので harvested_at も同じ）
  expect(await stemRow(stemId)).toMatchObject({ status: "harvested", harvested_at: daysAgoJst(1), ended_at: daysAgoJst(1) });

  for (const url of [`/stems/${stemId}`, `/stems/${stemId}/history`]) {
    await page.goto(url);
    await expect(view(page).getByTestId("stem-status")).toHaveText("収穫済み");
    await expect(view(page).getByTestId("history-item")).toHaveCount(2);
    await expect(row(page, newEv.id).getByTestId("history-value")).toHaveText("13.5 kg");
    await expect(row(page, newEv.id).getByTestId("history-correction")).toBeVisible();
    await expect(row(page, oldId)).toHaveAttribute("data-superseded", "true");
    await expect(row(page, oldId).getByTestId("history-value")).toHaveText("12.3 kg");
    await expect(row(page, oldId).getByTestId("history-superseded")).toHaveText("訂正済み → 13.5 kg");
  }
});

test("3. どの行も削除できない（削除の UI がない）。DB でも削除できない", async ({ page }) => {
  const { code, stemId } = await setupStem("flowered", 5);
  const obsId = await insertLeavesNew(stemId, 1, `${daysAgoJst(3)}T09:00:00+09:00`);
  await recordEvent(stemId, "hands_counted", `${daysAgoJst(2)}T00:00:00+09:00`, { hands: 8 });

  // 観測を訂正して、訂正済みの行・訂正で追加された行・ふつうの行がそろった状態にする
  await openStem(page, stemId, code);
  const dialog = await openCorrection(page, obsId);
  await dialog.getByTestId("correct-value").fill("2");
  await dialog.getByTestId("correct-submit").click();
  await expect(page.getByTestId("correct-dialog")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(row(page, obsId)).toHaveAttribute("data-superseded", "true", { timeout: ACTION_TIMEOUT });

  for (const url of [`/stems/${stemId}`, `/stems/${stemId}/history`]) {
    await page.goto(url);
    await expect(view(page).getByTestId("history-item")).toHaveCount(3);
    await expect(page.getByRole("button", { name: /削除|消す|取り消/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /削除|消す|取り消/ })).toHaveCount(0);
    // 各行の操作は「訂正」だけ（訂正済みの行には何もない）
    await expect(view(page).getByTestId("history-item").locator("button:not([data-testid=correct-open]), a, input, select, textarea")).toHaveCount(0);
    await expect(view(page).getByTestId("history-item").getByTestId("correct-open")).toHaveCount(2);
    await expect(row(page, obsId).getByTestId("correct-open")).toHaveCount(0);
    // 訂正ダイアログにも削除の操作がない
    const hands = view(page).locator('[data-testid="history-item"][data-type="hands_counted"]');
    await hands.getByTestId("correct-open").click();
    const d = page.getByTestId("correct-dialog");
    await expect(d).toBeVisible();
    await expect(d.getByRole("button")).toHaveText(["やめる", "訂正する"]);
    await d.getByTestId("correct-cancel").click();
    await expect(page.getByTestId("correct-dialog")).toHaveCount(0);
  }

  // DB の正本: 観測・イベントは削除できない（delete ポリシーがない → 0 件）
  const supabase = await supabaseAsA();
  const { error: delObsError, count: obsCount } = await supabase.from("observations").delete({ count: "exact" }).eq("stem_id", stemId);
  expect(delObsError === null ? obsCount : -1).toBe(0);
  const { error: delEvError, count: evCount } = await supabase
    .from("events")
    .delete({ count: "exact" })
    .eq("target_type", "stem")
    .eq("target_id", stemId);
  expect(delEvError === null ? evCount : -1).toBe(0);
  expect(await observationRows(stemId)).toHaveLength(2);
  expect(await eventRows(stemId)).toHaveLength(1);
});

test("同じ行を 2 回訂正しようとすると 2 回目は拒否される。最新の行なら訂正できる", async ({ page, context }) => {
  const { code, stemId } = await setupStem("active", 5);
  const oldId = await insertLeavesNew(stemId, 1, `${daysAgoJst(2)}T09:00:00+09:00`);

  // 2 つの画面で同じ茎を開いておく（片方は古いまま）
  const stale = await context.newPage();
  await openStem(stale, stemId, code);
  await openStem(page, stemId, code);

  const d1 = await openCorrection(page, oldId);
  await d1.getByTestId("correct-value").fill("2");
  await d1.getByTestId("correct-submit").click();
  await expect(page.getByTestId("correct-dialog")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("7", { timeout: ACTION_TIMEOUT });

  // 古い画面から同じ（訂正済みの）行を訂正 → 拒否。入力は残り、記録は増えない
  const d2 = await openCorrection(stale, oldId);
  await d2.getByTestId("correct-value").fill("3");
  await d2.getByTestId("correct-submit").click();
  await expect(d2.getByTestId("correct-error")).toHaveText("この記録はすでに訂正されています。最新の記録を訂正してください", {
    timeout: ACTION_TIMEOUT,
  });
  await expect(d2.getByTestId("correct-value")).toHaveValue("3");
  expect(await observationRows(stemId)).toHaveLength(2);
  await stale.close();

  // RPC でも拒否される
  const supabase = await supabaseAsA();
  const { error } = await supabase.rpc("correct_observation", {
    p_new_id: crypto.randomUUID(),
    p_old_id: oldId,
    p_value: 3,
    p_observed_at: new Date().toISOString(),
  });
  expect(error?.message).toBe("この記録はすでに訂正されています。最新の記録を訂正してください");

  // 最新の行（+2）は訂正できる → +3。累計 8、訂正の連鎖が残る
  const latestId = (await observationRows(stemId))[1].id;
  const d3 = await openCorrection(page, latestId);
  await expect(d3.getByTestId("correct-value")).toHaveValue("2");
  await d3.getByTestId("correct-value").fill("3");
  await d3.getByTestId("correct-submit").click();
  await expect(page.getByTestId("correct-dialog")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("8", { timeout: ACTION_TIMEOUT });
  const rows = await observationRows(stemId);
  expect(rows.map((r) => Number(r.value))).toEqual([1, 2, 3]);
  expect(rows[0].superseded_by).toBe(rows[1].id);
  expect(rows[1].superseded_by).toBe(rows[2].id);
  expect(rows[2].superseded_by).toBeNull();
  await expect(row(page, latestId).getByTestId("history-superseded")).toHaveText("訂正済み → +3");
  await expect(row(page, latestId).getByTestId("history-correction")).toBeVisible();

  // 同じ新しい id での再送は二重にならない（冪等）
  const { error: againError, data: againId } = await supabase.rpc("correct_observation", {
    p_new_id: rows[2].id,
    p_old_id: rows[1].id,
    p_value: 3,
    p_observed_at: rows[2].observed_at,
  });
  expect(againError).toBeNull();
  expect(againId).toBe(rows[2].id);
  expect(await observationRows(stemId)).toHaveLength(3);
});

test("出蕾日を訂正すると stems.bud_emerged_at が変わる。出蕾時の累計葉数（記録）は変わらない", async ({ page }) => {
  const { code, stemId } = await setupStem("active", 5);
  await insertLeavesNew(stemId, 1, `${daysAgoJst(10)}T09:00:00+09:00`);
  const budId = await recordEvent(stemId, "bud_emerged", new Date().toISOString(), {
    cumulative_leaves: 6,
    leaves_current: 10,
    girth_cm: 45.5,
    earliest_at: null,
  });
  expect((await stemRow(stemId)).bud_emerged_at).toBe(todayJst());

  await openStem(page, stemId, code);
  const dialog = await openCorrection(page, budId);
  await expect(dialog).toHaveAttribute("data-type", "bud_emerged");
  await expect(dialog.getByTestId("correct-date")).toHaveValue(todayJst());
  await expect(dialog.getByTestId("correct-leaves-current")).toHaveValue("10");
  await expect(dialog.getByTestId("correct-girth-cm")).toHaveValue("45.5");
  await dialog.getByTestId("correct-date").fill(daysAgoJst(3));
  await dialog.getByTestId("correct-girth-cm").fill("46");
  await dialog.getByTestId("correct-submit").click();
  await expect(page.getByTestId("correct-dialog")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(row(page, budId)).toHaveAttribute("data-superseded", "true", { timeout: ACTION_TIMEOUT });

  expect(await stemRow(stemId)).toMatchObject({ status: "flowered", bud_emerged_at: daysAgoJst(3) });
  const events = await eventRows(stemId);
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    type: "bud_emerged",
    superseded_by: null,
    payload: { cumulative_leaves: 6, leaves_current: 10, girth_cm: 46, earliest_at: null },
  });
  expect(jst(new Date(events[1].occurred_at))).toBe(daysAgoJst(3));
  await expect(row(page, budId).getByTestId("history-superseded")).toHaveText(
    `訂正済み → 累計葉数 6 枚・生葉数 10 枚・周囲長 46 cm（${daysAgoJst(3)}）`,
  );
  await expect(view(page).getByTestId("stem-status")).toHaveText("出蕾済み");
});

test("出蕾前の +1 を訂正すると「出蕾時の累計（記録）/ 現在の計算」が両方出る", async ({ page }) => {
  const { code, stemId } = await setupStem("active", 5);
  const leafId = await insertLeavesNew(stemId, 1, `${daysAgoJst(10)}T09:00:00+09:00`);
  await recordEvent(stemId, "bud_emerged", new Date().toISOString(), {
    cumulative_leaves: 6,
    leaves_current: 10,
    girth_cm: 45.5,
    earliest_at: null,
  });

  await openStem(page, stemId, code);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("6");
  // 記録と計算が一致している間は出さない
  await expect(view(page).getByTestId("stem-bud-snapshot")).toHaveCount(0);

  const dialog = await openCorrection(page, leafId);
  await dialog.getByTestId("correct-value").fill("2");
  await dialog.getByTestId("correct-submit").click();
  await expect(page.getByTestId("correct-dialog")).toHaveCount(0, { timeout: ACTION_TIMEOUT });

  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("7", { timeout: ACTION_TIMEOUT });
  for (const url of [`/stems/${stemId}`, `/stems/${stemId}/history`]) {
    await page.goto(url);
    await expect(view(page).getByTestId("stem-bud-snapshot")).toHaveText("出蕾時の累計葉数（記録）6 枚 / 現在の計算 7 枚");
  }
  // 出蕾イベントの payload は出蕾時点の記録のまま（自動で直さない）
  const events = await eventRows(stemId);
  expect(events).toHaveLength(1);
  expect(events[0].payload).toMatchObject({ cumulative_leaves: 6 });
});

test("オフラインでは訂正ボタンが無効で理由が出る。未同期の記録は「同期してから」", async ({ page, context }) => {
  const { code, stemId } = await setupStem("active", 5);
  const oldId = await insertLeavesNew(stemId, 1, `${daysAgoJst(2)}T09:00:00+09:00`);
  await openStem(page, stemId, code);
  await expect(row(page, oldId).getByTestId("correct-open")).toBeEnabled();

  await context.setOffline(true);
  try {
    await expect(row(page, oldId).getByTestId("correct-open")).toBeDisabled();
    await expect(row(page, oldId).getByTestId("correct-disabled-reason")).toHaveText(
      "訂正は電波のあるところで行ってください（端末に貯めません）",
    );
    // 圏外で記録した +1（未同期）も訂正できない
    await view(page).getByTestId("leaves-new-1").click();
    const pendingRow = view(page).locator('[data-testid="history-item"][data-pending="true"]');
    await expect(pendingRow).toHaveCount(1);
    await expect(pendingRow.getByTestId("correct-open")).toBeDisabled();
    await expect(pendingRow.getByTestId("correct-disabled-reason")).toHaveText("同期してから訂正してください");
  } finally {
    await context.setOffline(false);
  }
  // オンラインに戻り同期されると訂正できる
  await waitForSynced(page);
  await expect(row(page, oldId).getByTestId("correct-open")).toBeEnabled();
  await expect(view(page).locator('[data-testid="history-item"][data-pending="true"]')).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("history-item").getByTestId("correct-open")).toHaveCount(2);
  for (const b of await view(page).getByTestId("history-item").getByTestId("correct-open").all()) {
    await expect(b).toBeEnabled();
  }
  // 訂正は 1 件も記録されていない
  expect((await observationRows(stemId)).every((r) => r.superseded_by === null)).toBe(true);
});

test("訂正した行（superseded_by の参照あり）も E2E の掃除（e2e_cleanup_fields）で消える", async () => {
  const field = await createField("E2E訂正掃除");
  const supabase = field.supabase;
  const { data: f } = await supabase.from("fields").select("name").eq("id", field.id).single();
  const matId = await createMat(field.id, `${field.code}-001`);
  const stemId = await createStem(matId, { status: "flowered", initialLeafCount: 5 });
  const obsId = await insertLeavesNew(stemId, 1, new Date().toISOString());
  const evId = await recordEvent(stemId, "hands_counted", new Date().toISOString(), { hands: 8 });
  const { error: e1 } = await supabase.rpc("correct_observation", {
    p_new_id: crypto.randomUUID(),
    p_old_id: obsId,
    p_value: 2,
    p_observed_at: new Date().toISOString(),
  });
  expect(e1).toBeNull();
  const { error: e2 } = await supabase.rpc("correct_stem_event", {
    p_new_id: crypto.randomUUID(),
    p_old_id: evId,
    p_occurred_at: new Date().toISOString(),
    p_payload: { hands: 9 },
  });
  expect(e2).toBeNull();
  expect(await observationRows(stemId)).toHaveLength(2);
  expect(await eventRows(stemId)).toHaveLength(2);

  const { data: deleted, error } = await supabase.rpc("e2e_cleanup_fields", { prefix: f!.name as string });
  expect(error).toBeNull();
  expect(deleted).toBe(1);
  expect(await observationRows(stemId)).toHaveLength(0);
  expect(await eventRows(stemId)).toHaveLength(0);
  const { data: stems } = await supabase.from("stems").select("id").eq("id", stemId);
  expect(stems).toEqual([]);
});

test("被害「喪失」の訂正は日付・種類だけ。喪失 ⇔ 喪失以外は画面でも RPC でも拒否される", async ({ page }) => {
  const { code, stemId } = await setupStem("active", 5);
  const lostId = await recordEvent(stemId, "damage", `${daysAgoJst(2)}T00:00:00+09:00`, { kind: "lodging", severity: "lost" });
  expect(await stemRow(stemId)).toMatchObject({ status: "lost", ended_at: daysAgoJst(2) });

  await openStem(page, stemId, code);
  const dialog = await openCorrection(page, lostId);
  // 程度は「喪失」だけ選べる
  await expect(dialog.getByTestId("correct-severity").locator("option")).toHaveText(["喪失"]);
  await dialog.getByTestId("correct-kind").selectOption("break");
  await dialog.getByTestId("correct-date").fill(daysAgoJst(3));
  await dialog.getByTestId("correct-submit").click();
  await expect(page.getByTestId("correct-dialog")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(row(page, lostId)).toHaveAttribute("data-superseded", "true", { timeout: ACTION_TIMEOUT });
  // 状態は喪失のまま、ended_at は新しい日付
  expect(await stemRow(stemId)).toMatchObject({ status: "lost", ended_at: daysAgoJst(3) });

  const events = await eventRows(stemId);
  expect(events[1]).toMatchObject({ payload: { kind: "break", severity: "lost" }, superseded_by: null });
  const supabase = await supabaseAsA();
  const { error } = await supabase.rpc("correct_stem_event", {
    p_new_id: crypto.randomUUID(),
    p_old_id: events[1].id,
    p_occurred_at: events[1].occurred_at,
    p_payload: { kind: "break", severity: "light" },
  });
  expect(error?.message).toContain("「喪失」の被害は程度を変えられません");
  expect(await eventRows(stemId)).toHaveLength(2);
});

test("圃場の記録・株の記録（被害・施肥）には訂正ボタンが出ない（訂正できるのは茎の記録だけ）", async ({ page }) => {
  const { matId } = await setupStem("active", 5);
  const supabase = await supabaseAsA();
  const now = new Date().toISOString();
  const { error } = await supabase.from("events").insert([
    { type: "damage", target_type: "field", target_id: sharedField.id, occurred_at: now, payload: { kind: "lodging", severity: "severe" } },
    { type: "damage", target_type: "mat", target_id: matId, occurred_at: now, payload: { kind: "break", severity: "light" } },
    { type: "fertilized", target_type: "mat", target_id: matId, occurred_at: now, payload: { fertilizer: "E2E肥料", amount: 1, unit: "kg", batch_id: crypto.randomUUID() } },
  ]);
  expect(error).toBeNull();

  await page.goto(`/fields/${sharedField.id}`);
  const fieldHistory = page.getByTestId("field-history");
  await expect(fieldHistory.locator('[data-testid="history-item"][data-type="damage"]').first()).toBeVisible();
  await expect(fieldHistory.getByTestId("correct-open")).toHaveCount(0);
  await expect(fieldHistory.getByRole("button")).toHaveCount(0);

  await page.goto(`/mats/${matId}`);
  const matHistory = page.getByTestId("mat-history");
  await expect(matHistory.getByTestId("history-item")).toHaveCount(2);
  await expect(matHistory.getByTestId("correct-open")).toHaveCount(0);
  await expect(matHistory.getByRole("button")).toHaveCount(0);
});
