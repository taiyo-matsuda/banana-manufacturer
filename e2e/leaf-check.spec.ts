import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, supabaseAsA, test, waitForSynced } from "./helpers";
import { createField, createMat, createStem } from "./map-helpers";
import { jstDateOf } from "../src/lib/weather/dates";

// 3-5a 累計葉数の検算を「現在の葉数を記録した時点」で比べる（prediction.md 6 章「検算の式」）。完了条件 1〜3 を 1 つずつ検証する
// （式そのものは src/lib/leaves.test.ts、提案の判定は src/lib/recommendations/evaluate.test.ts）。
// 茎の画面の警告・株の詳細の茎一覧の「検算ずれ」・「確認」の提案（inspect、leaf_check:<観測 id>）が同じ式を使うことを、
// 3 か所すべてで確かめる。テスト農園 A でログイン済み（setup の storageState）。テストごとにログインしない。

const view = (page: Page) => page.locator("main:visible");
const today = () => jstDateOf(new Date());

let sharedField: Awaited<ReturnType<typeof createField>>;
let matSeq = 0;

test.beforeAll(async () => {
  sharedField = await createField("E2E検算");
});

async function setupStem(initialLeafCount = 5) {
  matSeq += 1;
  const code = `${sharedField.code}-${String(matSeq).padStart(3, "0")}`;
  const matId = await createMat(sharedField.id, code);
  const stemId = await createStem(matId, { initialLeafCount });
  return { code, matId, stemId };
}

type InspectRow = {
  id: string;
  rule_key: string;
  reason: string | null;
  status: string;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_event_id: string | null;
};

async function inspects(stemId: string): Promise<InspectRow[]> {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("recommendations")
    .select("id, rule_key, reason, status, resolution_note, resolved_by, resolved_event_id")
    .eq("target_type", "stem")
    .eq("target_id", stemId)
    .eq("kind", "inspect")
    .order("created_at");
  if (error) throw new Error(`recommendations を読めません: ${error.message}`);
  return (data ?? []) as InspectRow[];
}

async function userIdA(): Promise<string> {
  const supabase = await supabaseAsA();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("A のユーザーを取得できません");
  return user.id;
}

async function leavesCurrentIds(stemId: string): Promise<string[]> {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("observations")
    .select("id")
    .eq("stem_id", stemId)
    .eq("type", "leaves_current")
    .order("observed_at");
  if (error) throw new Error(`観測を読めません: ${error.message}`);
  return (data ?? []).map((r) => r.id as string);
}

// 同期ワーカーが観測の送信後に呼ぶのと同じ再計算（推定 → 提案）
async function recompute(page: Page, stemId: string) {
  const res = await page.request.post("/api/predictions/recompute", { data: { stemId } });
  expect(res.status()).toBe(200);
}

async function openStem(page: Page, stemId: string, code: string) {
  await page.goto(`/stems/${stemId}`);
  await expect(view(page).getByTestId("stem-mat-code")).toHaveText(code, { timeout: ACTION_TIMEOUT });
}

async function recordCurrent(page: Page, value: number) {
  await view(page).getByTestId("leaves-current-input").fill(String(value));
  await view(page).getByTestId("leaves-current-submit").click();
  await expect(view(page).getByTestId("stem-leaves-by-check")).toHaveText(`${value} 枚`, { timeout: ACTION_TIMEOUT });
}

// +1 / +2 を押して、累計が増えたのを待つ
async function recordNew(page: Page, n: 1 | 2, cumulativeAfter: number) {
  await view(page).getByTestId(`leaves-new-${n}`).click();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText(String(cumulativeAfter), { timeout: ACTION_TIMEOUT });
}

const matStemItem = (page: Page, stemId: string) => view(page).locator(`[data-testid="stem-item"][data-stem-id="${stemId}"]`);

test("完了条件 1: 現在の葉数を記録した後に新葉を 3 枚以上記録しても、警告も「確認」も出ない", async ({ page }) => {
  const s = await setupStem(5);
  await openStem(page, s.stemId, s.code);

  // 現在の葉数 5（累計 5 とずれなし）を記録してから、新葉 +1・+2・+1（計 4 枚）
  await recordCurrent(page, 5);
  await recordNew(page, 1, 6);
  await recordNew(page, 2, 8);
  await recordNew(page, 1, 9);

  // 茎の画面: 累計は 9（後の新葉も数える）。検算は記録時点（累計 5・検算 5）で比べるので警告なし
  await expect(view(page).getByTestId("stem-check-cumulative")).toHaveText("5");
  await expect(view(page).getByTestId("stem-leaves-by-check")).toHaveText("5 枚");
  await expect(view(page).getByTestId("leaf-check-warning")).toHaveCount(0);

  // 同期・再読み込みの後も警告なし
  await waitForSynced(page);
  await page.reload();
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("9");
  await expect(view(page).getByTestId("leaf-check-warning")).toHaveCount(0);

  // 提案: 同期の後の再計算でも「確認」は作られない（以前の式なら 9 と 5 で 4 枚のずれ）
  await recompute(page, s.stemId);
  expect(await inspects(s.stemId)).toEqual([]);
  await page.goto("/recommendations");
  await expect(view(page).getByText("読み込み中…")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(view(page).locator(`[data-testid="recommendation-row"][data-stem-id="${s.stemId}"][data-kind="inspect"]`)).toHaveCount(0);

  // 株の詳細の茎一覧: 累計 9、「検算ずれ」なし
  await page.goto(`/mats/${s.matId}`);
  await expect(matStemItem(page, s.stemId).getByTestId("stem-cumulative-leaves")).toHaveText("9", { timeout: ACTION_TIMEOUT });
  await expect(matStemItem(page, s.stemId).getByTestId("stem-leaf-check-warning")).toHaveCount(0);
  await expect(matStemItem(page, s.stemId).getByTestId("stem-leaf-check")).toHaveCount(0);
});

test("完了条件 2: 記録した時点で 3 枚以上ずれていれば警告と「確認」が出る（後の新葉では消えない）。現在の葉数を記録し直すと done", async ({
  page,
}) => {
  const s = await setupStem(5);
  await openStem(page, s.stemId, s.code);

  // 現在の葉数 9（記録時点の累計 5 と 4 枚ずれる）→ 警告
  await recordCurrent(page, 9);
  const warning = "確認してください（記録時点の累計 5、検算 9）";
  await expect(view(page).getByTestId("leaf-check-warning")).toHaveText(warning, { timeout: ACTION_TIMEOUT });

  // その後に新葉 +2（累計 7。以前の式なら 7 と 9 で 2 枚 → 警告が消えていた）。記録時点で比べるので警告のまま
  await recordNew(page, 2, 7);
  await expect(view(page).getByTestId("leaf-check-warning")).toHaveText(warning);
  await expect(view(page).getByTestId("stem-check-cumulative")).toHaveText("5");

  // 同期の後: 「確認」が open（rule_key は検算に使った現在の葉数の観測、理由は記録時点の値）
  await waitForSynced(page);
  const [currentId] = await leavesCurrentIds(s.stemId);
  await recompute(page, s.stemId);
  await expect.poll(async () => (await inspects(s.stemId)).map((r) => r.status), { timeout: ACTION_TIMEOUT }).toEqual(["open"]);
  expect((await inspects(s.stemId))[0]).toMatchObject({
    rule_key: `leaf_check:${currentId}`,
    reason: "累計葉数の検算が 4 枚ずれています（記録時点の累計 5、検算 9）",
  });

  // 株の詳細の茎一覧にも同じ式の「検算ずれ」
  await page.goto(`/mats/${s.matId}`);
  await expect(matStemItem(page, s.stemId).getByTestId("stem-leaf-check-warning")).toHaveText("検算ずれ", { timeout: ACTION_TIMEOUT });
  await expect(matStemItem(page, s.stemId).getByTestId("stem-leaf-check")).toHaveText("記録時点の累計 5・検算 9");

  // 数え直して現在の葉数 7 を記録（今の累計 7 と一致）→ 警告が消え、「確認」は done（記録者）
  await openStem(page, s.stemId, s.code);
  await recordCurrent(page, 7);
  await expect(view(page).getByTestId("leaf-check-warning")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(view(page).getByTestId("stem-check-cumulative")).toHaveText("7");
  await waitForSynced(page);
  await expect.poll(async () => (await inspects(s.stemId)).map((r) => r.status), { timeout: ACTION_TIMEOUT }).toEqual(["done"]);
  expect((await inspects(s.stemId))[0]).toMatchObject({ resolution_note: "現在の葉数を記録", resolved_by: await userIdA(), resolved_event_id: null });

  await page.goto(`/mats/${s.matId}`);
  await expect(matStemItem(page, s.stemId).getByTestId("stem-cumulative-leaves")).toHaveText("7", { timeout: ACTION_TIMEOUT });
  await expect(matStemItem(page, s.stemId).getByTestId("stem-leaf-check-warning")).toHaveCount(0);
});

test("完了条件 3: 以前の式で出た open の「確認」は、新しい式でずれていなければ再計算で done（検算のずれが解消）", async ({ page }) => {
  const s = await setupStem(5);
  const supabase = await supabaseAsA();
  const user = await userIdA();
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

  // 3-5a より前の状態を DB に作る: 現在の葉数 5（累計 5 と一致）の後に新葉 2 + 2。
  // 以前の式（今の累計 9 と 5）で出ていた「確認」が open のまま残っている
  const currentId = crypto.randomUUID();
  const { error: obsError } = await supabase.from("observations").insert([
    { id: currentId, stem_id: s.stemId, type: "leaves_current", value: 5, observed_at: at(120), observed_by: user },
    { id: crypto.randomUUID(), stem_id: s.stemId, type: "leaves_new", value: 2, observed_at: at(60), observed_by: user },
    { id: crypto.randomUUID(), stem_id: s.stemId, type: "leaves_new", value: 2, observed_at: at(30), observed_by: user },
  ]);
  if (obsError) throw new Error(`観測を作れません: ${obsError.message}`);
  const { error: recError } = await supabase.from("recommendations").insert({
    kind: "inspect",
    target_type: "stem",
    target_id: s.stemId,
    rule_key: `leaf_check:${currentId}`,
    due_at: today(),
    reason: "累計葉数の検算が 4 枚ずれています（累計 9、検算 5）",
  });
  if (recError) throw new Error(`提案を作れません: ${recError.message}`);
  expect((await inspects(s.stemId)).map((r) => r.status)).toEqual(["open"]);

  // 茎の画面: 新しい式では記録時点の累計 5・検算 5 で警告なし
  await openStem(page, s.stemId, s.code);
  await expect(view(page).getByTestId("stem-cumulative-leaves")).toHaveText("9");
  await expect(view(page).getByTestId("stem-check-cumulative")).toHaveText("5");
  await expect(view(page).getByTestId("leaf-check-warning")).toHaveCount(0);

  // 再計算（同期・日次の Cron と同じ入口）で done「検算のずれが解消」。根拠のイベントはない。次の確認は作らない
  await recompute(page, s.stemId);
  const rows = await inspects(s.stemId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: "done", resolution_note: "検算のずれが解消", resolved_event_id: null });

  // 一覧からも消える
  await page.goto("/recommendations");
  await expect(view(page).getByText("読み込み中…")).toHaveCount(0, { timeout: ACTION_TIMEOUT });
  await expect(view(page).locator(`[data-testid="recommendation-row"][data-stem-id="${s.stemId}"][data-kind="inspect"]`)).toHaveCount(0);
});
