import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, supabaseAsA, test } from "./helpers";
import { CENTER, createField, dwarfNamwaId } from "./map-helpers";

// 2-4 施肥の一括入力（画面 5）。完了条件 1・2 を 1 つずつ検証し、加えて
// 上の量を変えると個別に変えていない株が追従する / 撤去した株は一覧に出ない / 肥料名が空・量が 0 以下・対象 0 株なら
// 確定できず理由が出る / サーバーのエラーで戻っても入力・選択・個別の量が残る / 2 回目の施肥で前回の肥料名が候補に出る /
// 圏外では確定できず理由が出る / 100 株の圃場でも一覧の操作と確定ができる、を確かめる。
// テスト農園 A でログイン済み（setup の storageState）。圃場・株は DB に直接作る（名前は E2E で始め、setup の掃除で消える）。

type Field = Awaited<ReturnType<typeof createField>>;

// 株をまとめて DB に作る（コードは `<圃場記号>-001` から連番）。株コード順 = 作った順
async function createMats(field: Field, count: number) {
  const supabase = await supabaseAsA();
  const cultivarId = await dwarfNamwaId();
  const rows = Array.from({ length: count }, (_, i) => ({
    field_id: field.id,
    code: `${field.code}-${String(i + 1).padStart(3, "0")}`,
    cultivar_id: cultivarId,
    lat: CENTER.lat,
    lng: CENTER.lng,
    planted_at: "2026-09-15",
    origin_type: "tissue_culture",
  }));
  const { data, error } = await supabase.from("mats").insert(rows).select("id, code").order("code");
  if (error || !data) throw new Error(`株を作れません: ${error?.message}`);
  return data as { id: string; code: string }[];
}

async function fieldWithMats(prefix: string, count: number) {
  const field = await createField(prefix);
  const mats = await createMats(field, count);
  return { field, mats };
}

type FertilizedRow = {
  target_id: string;
  target_type: string;
  organization_id: string | null;
  payload: { fertilizer: string; amount: number; unit: string; batch_id: string };
};

async function fertilizedEvents(matIds: string[]): Promise<FertilizedRow[]> {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("events")
    .select("target_id, target_type, organization_id, payload")
    .eq("type", "fertilized")
    .eq("target_type", "mat")
    .in("target_id", matIds);
  if (error) throw new Error(`イベントを読めません: ${error.message}`);
  return (data ?? []) as FertilizedRow[];
}

function uniqueFertilizer(label: string) {
  return `E2E${label}-${test.info().project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// 圃場の詳細の導線から施肥の画面を開く
async function openFertilize(page: Page, fieldId: string) {
  await page.goto(`/fields/${fieldId}`);
  await page.getByTestId("field-fertilize-link").click();
  await expect(page).toHaveURL(`/fields/${fieldId}/fertilize`);
  await expect(page.getByTestId("fertilize-form")).toBeVisible({ timeout: ACTION_TIMEOUT });
}

const row = (page: Page, code: string) => page.locator(`[data-testid="fertilize-mat-row"][data-code="${code}"]`);

async function confirmAndRecord(page: Page, expectedSummary: string) {
  await page.getByTestId("fertilize-submit").click();
  const dialog = page.getByTestId("fertilize-confirm-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("fertilize-confirm-summary")).toHaveText(expectedSummary);
  await page.getByTestId("fertilize-confirm-submit").click();
  await expect(page.getByTestId("fertilize-done")).toBeVisible({ timeout: ACTION_TIMEOUT });
  await expect(page.getByTestId("fertilize-done-summary")).toContainText(expectedSummary);
}

test.describe("施肥の一括入力", () => {
  test("完了条件 1: 6 株の圃場で 1 株を外し 1 株の量を変えて確定すると、5 件のイベントができ量が株ごとに正しい。同じ batch_id で束ねられている", async ({
    page,
  }) => {
    const { field, mats } = await fieldWithMats("E2E施肥", 6);
    const name = uniqueFertilizer("化成");
    await openFertilize(page, field.id);

    // 既定: 撤去していない全株が株コード順で対象
    const rows = page.getByTestId("fertilize-mat-row");
    await expect(rows).toHaveCount(6);
    for (let i = 0; i < 6; i++) await expect(rows.nth(i)).toHaveAttribute("data-code", mats[i].code);
    await expect(page.getByTestId("fertilize-count")).toHaveText("6");
    await expect(rows.nth(0).getByTestId("fertilize-mat-check")).toBeChecked();
    // 日付の既定は今日
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
    await expect(page.getByTestId("fertilize-date")).toHaveValue(today);

    await page.getByTestId("fertilize-name").fill(name);
    await page.getByTestId("fertilize-amount").fill("0.5");
    await page.getByTestId("fertilize-unit").selectOption("kg");
    // 個別に変えていない行は上の量を表示する
    for (let i = 0; i < 6; i++) await expect(rows.nth(i).getByTestId("fertilize-mat-amount")).toHaveValue("0.5");
    await expect(page.getByTestId("fertilize-total")).toHaveText("3 kg");

    // 2 番目の株を外す
    await row(page, mats[1].code).getByTestId("fertilize-mat-check").click();
    await expect(row(page, mats[1].code)).toHaveAttribute("data-included", "false");
    await expect(row(page, mats[1].code).getByTestId("fertilize-mat-check")).not.toBeChecked();
    await expect(row(page, mats[1].code).getByTestId("fertilize-mat-amount")).toBeDisabled();

    // 4 番目の株の量を変える → 変えた行は見て分かる
    await row(page, mats[3].code).getByTestId("fertilize-mat-amount").fill("1.2");
    await expect(row(page, mats[3].code)).toHaveAttribute("data-overridden", "true");
    await expect(row(page, mats[3].code).getByTestId("fertilize-mat-overridden")).toHaveText("個別");
    await expect(row(page, mats[0].code)).not.toHaveAttribute("data-overridden", "true");

    // 上の量を変えると、個別に変えていない行は追従し、変えた行はそのまま
    await page.getByTestId("fertilize-amount").fill("0.6");
    for (const i of [0, 2, 4, 5]) await expect(row(page, mats[i].code).getByTestId("fertilize-mat-amount")).toHaveValue("0.6");
    await expect(row(page, mats[3].code).getByTestId("fertilize-mat-amount")).toHaveValue("1.2");

    // 対象株数・合計量（0.6 × 4 + 1.2 = 3.6）
    await expect(page.getByTestId("fertilize-count")).toHaveText("5");
    await expect(page.getByTestId("fertilize-total")).toHaveText("3.6 kg");

    await confirmAndRecord(page, "5 株に合計 3.6 kg");

    // DB: 5 件。量が株ごとに正しい。同じ batch_id。外した株にはない。organization_id はトリガーが入れる
    const events = await fertilizedEvents(mats.map((m) => m.id));
    expect(events).toHaveLength(5);
    const byMat = new Map(events.map((e) => [e.target_id, e]));
    expect(byMat.has(mats[1].id)).toBe(false);
    for (const i of [0, 2, 4, 5]) expect(byMat.get(mats[i].id)?.payload.amount).toBe(0.6);
    expect(byMat.get(mats[3].id)?.payload.amount).toBe(1.2);
    for (const e of events) {
      expect(e.target_type).toBe("mat");
      expect(e.payload.fertilizer).toBe(name);
      expect(e.payload.unit).toBe("kg");
      expect(e.organization_id).toBeTruthy();
    }
    const batchIds = new Set(events.map((e) => e.payload.batch_id));
    expect(batchIds.size).toBe(1);
    expect([...batchIds][0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("完了条件 2: 株の詳細に施肥の記録（日付・肥料名・量・単位）が新しい順に出る。外した株には出ない", async ({ page }) => {
    const { field, mats } = await fieldWithMats("E2E施肥履歴", 2);
    // 以前の施肥（10 月 1 日）を DB に直接入れておく
    const supabase = await supabaseAsA();
    const { error } = await supabase.from("events").insert({
      type: "fertilized",
      target_type: "mat",
      target_id: mats[0].id,
      occurred_at: "2026-10-01T00:00:00+09:00",
      payload: { fertilizer: "E2E以前の肥料", amount: 2, unit: "g", batch_id: crypto.randomUUID() },
    });
    expect(error).toBeNull();

    const name = uniqueFertilizer("履歴");
    await openFertilize(page, field.id);
    await page.getByTestId("fertilize-name").fill(name);
    await page.getByTestId("fertilize-amount").fill("0.75");
    await page.getByTestId("fertilize-unit").selectOption("L");
    await row(page, mats[1].code).getByTestId("fertilize-mat-check").click();
    await confirmAndRecord(page, "1 株に合計 0.75 L");

    await page.goto(`/mats/${mats[0].id}`);
    const history = page.getByTestId("mat-history");
    const items = history.getByTestId("history-item");
    await expect(items).toHaveCount(2);
    // 新しい順: 今日の施肥が先
    await expect(items.nth(0)).toHaveAttribute("data-type", "fertilized");
    await expect(items.nth(0).getByTestId("history-label")).toHaveText("施肥");
    await expect(items.nth(0).getByTestId("history-value")).toHaveText(`${name} 0.75 L`);
    const todaySlash = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    await expect(items.nth(0).getByTestId("history-at")).toContainText(todaySlash);
    await expect(items.nth(1).getByTestId("history-value")).toHaveText("E2E以前の肥料 2 g");
    await expect(items.nth(1).getByTestId("history-at")).toContainText("2026/10/01");
    // 削除・編集の操作はない（追記のみ）
    await expect(history.getByRole("button")).toHaveCount(0);

    // 外した株には施肥の記録がない
    await page.goto(`/mats/${mats[1].id}`);
    await expect(page.getByTestId("mat-history").getByTestId("history-empty")).toBeVisible();
  });

  test("撤去した株は一覧に出ない", async ({ page }) => {
    const { field, mats } = await fieldWithMats("E2E施肥撤去", 3);
    const supabase = await supabaseAsA();
    const { error } = await supabase.rpc("remove_mat", {
      p_event_id: crypto.randomUUID(),
      p_mat_id: mats[1].id,
      p_occurred_at: new Date().toISOString(),
      p_reason: null,
    });
    expect(error).toBeNull();

    await openFertilize(page, field.id);
    await expect(page.getByTestId("fertilize-mat-row")).toHaveCount(2);
    await expect(row(page, mats[0].code)).toBeVisible();
    await expect(row(page, mats[2].code)).toBeVisible();
    await expect(row(page, mats[1].code)).toHaveCount(0);
    await expect(page.getByTestId("fertilize-summary")).toContainText("/ 2 株");
  });

  test("肥料名が空・量が 0 以下・対象が 0 株なら確定できず理由が出る", async ({ page }) => {
    const { field, mats } = await fieldWithMats("E2E施肥検証", 2);
    await openFertilize(page, field.id);
    const submit = page.getByTestId("fertilize-submit");
    const dialog = page.getByTestId("fertilize-confirm-dialog");

    // 肥料名が空
    await page.getByTestId("fertilize-amount").fill("1");
    await submit.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("fertilize-name-error")).toHaveText("肥料名を入力してください");
    await expect(page.getByTestId("fertilize-invalid")).toHaveText("肥料名を入力してください");

    // 量が 0
    await page.getByTestId("fertilize-name").fill(uniqueFertilizer("検証"));
    await page.getByTestId("fertilize-amount").fill("0");
    await expect(page.getByTestId("fertilize-name-error")).toHaveCount(0);
    await submit.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("fertilize-amount-error")).toContainText("0 より大きい数");
    await expect(page.getByTestId("fertilize-invalid")).toContainText("0 より大きい数");

    // 量が負
    await page.getByTestId("fertilize-amount").fill("-1");
    await submit.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("fertilize-amount-error")).toContainText("0 より大きい数");

    // 個別の量が 0
    await page.getByTestId("fertilize-amount").fill("1");
    await row(page, mats[0].code).getByTestId("fertilize-mat-amount").fill("0");
    await submit.click();
    await expect(dialog).toHaveCount(0);
    await expect(row(page, mats[0].code).getByTestId("fertilize-mat-error")).toContainText("0 より大きい数");
    await expect(page.getByTestId("fertilize-invalid")).toContainText("量が正しくない株があります");
    await row(page, mats[0].code).getByTestId("fertilize-mat-reset").click();
    await expect(row(page, mats[0].code).getByTestId("fertilize-mat-amount")).toHaveValue("1");

    // 全て外す → 対象 0 株
    await page.getByTestId("fertilize-select-none").click();
    await expect(page.getByTestId("fertilize-count")).toHaveText("0");
    await submit.click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("fertilize-invalid")).toHaveText("対象の株を 1 株以上選んでください");

    // 何も記録されていない
    expect(await fertilizedEvents(mats.map((m) => m.id))).toHaveLength(0);
  });

  test("サーバーのエラーで戻っても、入力・選択・個別の量が残る（記録はされない）", async ({ page }) => {
    const { field, mats } = await fieldWithMats("E2E施肥エラー", 4);
    const name = uniqueFertilizer("エラー");
    await openFertilize(page, field.id);
    await page.getByTestId("fertilize-name").fill(name);
    await page.getByTestId("fertilize-amount").fill("0.4");
    await page.getByTestId("fertilize-unit").selectOption("g");
    await row(page, mats[0].code).getByTestId("fertilize-mat-check").click();
    await row(page, mats[1].code).getByTestId("fertilize-mat-amount").fill("2.5");

    // 画面を開いた後に、対象の株（3 番目）が別の経路で撤去された
    const supabase = await supabaseAsA();
    const { error } = await supabase.rpc("remove_mat", {
      p_event_id: crypto.randomUUID(),
      p_mat_id: mats[2].id,
      p_occurred_at: new Date().toISOString(),
      p_reason: null,
    });
    expect(error).toBeNull();

    await page.getByTestId("fertilize-submit").click();
    await expect(page.getByTestId("fertilize-confirm-summary")).toHaveText("3 株に合計 3.3 g");
    await page.getByTestId("fertilize-confirm-submit").click();
    await expect(page.getByTestId("fertilize-invalid")).toContainText("撤去した株が含まれています", { timeout: ACTION_TIMEOUT });
    await expect(page.getByTestId("fertilize-confirm-dialog")).toHaveCount(0);

    // 入力・選択・個別の量が残る
    await expect(page.getByTestId("fertilize-name")).toHaveValue(name);
    await expect(page.getByTestId("fertilize-amount")).toHaveValue("0.4");
    await expect(page.getByTestId("fertilize-unit")).toHaveValue("g");
    await expect(row(page, mats[0].code)).toHaveAttribute("data-included", "false");
    await expect(row(page, mats[1].code)).toHaveAttribute("data-overridden", "true");
    await expect(row(page, mats[1].code).getByTestId("fertilize-mat-amount")).toHaveValue("2.5");
    await expect(page.getByTestId("fertilize-count")).toHaveText("3");

    // 1 件も記録されていない（配列 insert の前に拒否）
    expect(await fertilizedEvents(mats.map((m) => m.id))).toHaveLength(0);
  });

  test("応答が届かずに同じ内容で再送しても二重に記録されない（同じ batch_id で 1 回分）", async ({ page }) => {
    const { field, mats } = await fieldWithMats("E2E施肥再送", 4);
    await openFertilize(page, field.id);
    await page.getByTestId("fertilize-name").fill(uniqueFertilizer("再送"));
    await page.getByTestId("fertilize-amount").fill("0.5");
    await page.getByTestId("fertilize-unit").selectOption("kg");

    // 1 回目の Server Action だけ、リクエストはサーバーに届けて（insert される）応答を端末に返さない
    let dropped = 0;
    await page.route(`**/fields/${field.id}/fertilize`, async (route) => {
      const req = route.request();
      if (dropped === 0 && req.method() === "POST" && req.headers()["next-action"]) {
        dropped++;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    await page.getByTestId("fertilize-submit").click();
    await page.getByTestId("fertilize-confirm-submit").click();
    await expect(page.getByTestId("fertilize-error")).toContainText("保存できませんでした", { timeout: ACTION_TIMEOUT });
    expect(dropped).toBe(1);
    // サーバーには記録されている
    await expect.poll(async () => (await fertilizedEvents(mats.map((m) => m.id))).length).toBe(4);

    // 内容を変えずに再送 → 成功として返り、件数は対象株数のまま、batch_id は 1 種類
    await confirmAndRecord(page, "4 株に合計 2 kg");
    const events = await fertilizedEvents(mats.map((m) => m.id));
    expect(events).toHaveLength(4);
    expect(new Set(events.map((e) => e.payload.batch_id)).size).toBe(1);
  });

  test("応答が届かなかった後に内容を変えて送ると、新しい batch_id で別の記録になる（前の batch_id に吸収されない）", async ({ page }) => {
    const { field, mats } = await fieldWithMats("E2E施肥再送変更", 2);
    await openFertilize(page, field.id);
    await page.getByTestId("fertilize-name").fill(uniqueFertilizer("再送変更"));
    await page.getByTestId("fertilize-amount").fill("1");
    await page.getByTestId("fertilize-unit").selectOption("kg");

    // 1 回目の Server Action は、サーバーに届けて（insert される）応答を端末に返さない
    let aborted = 0;
    await page.route(`**/fields/${field.id}/fertilize`, async (route) => {
      const req = route.request();
      if (aborted === 0 && req.method() === "POST" && req.headers()["next-action"]) {
        aborted++;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.getByTestId("fertilize-submit").click();
    await page.getByTestId("fertilize-confirm-submit").click();
    await expect(page.getByTestId("fertilize-error")).toContainText("保存できませんでした", { timeout: ACTION_TIMEOUT });

    await expect.poll(async () => (await fertilizedEvents(mats.map((m) => m.id))).length).toBe(2);

    // 量を変えて送り直す → 内容が違うので新しい batch_id。変えた内容も記録される（前の batch_id のまま「記録済み」と扱われない）
    await page.getByTestId("fertilize-amount").fill("2");
    await confirmAndRecord(page, "2 株に合計 4 kg");
    const events = await fertilizedEvents(mats.map((m) => m.id));
    expect(events).toHaveLength(4);
    const byBatch = new Map<string, number[]>();
    for (const e of events) byBatch.set(e.payload.batch_id, [...(byBatch.get(e.payload.batch_id) ?? []), e.payload.amount]);
    expect(byBatch.size).toBe(2);
    expect([...byBatch.values()].map((a) => a.join(",")).sort()).toEqual(["1,1", "2,2"]);
  });

  test("2 回目の施肥で、前回の肥料名が候補に出る", async ({ page }) => {
    const { field } = await fieldWithMats("E2E施肥候補", 2);
    const name = uniqueFertilizer("候補");
    await openFertilize(page, field.id);
    await page.getByTestId("fertilize-name").fill(name);
    await page.getByTestId("fertilize-amount").fill("1");
    await page.getByTestId("fertilize-unit").selectOption("kg");
    await confirmAndRecord(page, "2 株に合計 2 kg");

    // もう一度開くと、前回の肥料名が候補（入力欄の候補リストと、候補のボタン）に出る
    await openFertilize(page, field.id);
    await expect(page.getByTestId("fertilize-name")).toHaveValue("");
    await expect(page.locator(`#fertilize-name-suggestions option[value="${name}"]`)).toHaveCount(1);
    const chip = page.getByTestId("fertilize-suggestion").filter({ hasText: name });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.getByTestId("fertilize-name")).toHaveValue(name);
  });

  test("圏外では確定ボタンが無効になり、理由が出る", async ({ page, context }) => {
    const { field } = await fieldWithMats("E2E施肥圏外", 1);
    await openFertilize(page, field.id);
    await expect(page.getByTestId("fertilize-submit")).toBeEnabled();
    await context.setOffline(true);
    try {
      await expect(page.getByTestId("fertilize-submit")).toBeDisabled();
      await expect(page.getByTestId("fertilize-offline")).toContainText("電波のあるところ");
    } finally {
      await context.setOffline(false);
    }
    await expect(page.getByTestId("fertilize-submit")).toBeEnabled();
  });

  test("100 株の圃場でも一覧の操作（全て外す・全て選択・外す・量の個別変更）と確定ができる", async ({ page }) => {
    test.setTimeout(90_000);
    const { field, mats } = await fieldWithMats("E2E施肥多数", 100);
    await openFertilize(page, field.id);
    await expect(page.getByTestId("fertilize-mat-row")).toHaveCount(100);
    await page.getByTestId("fertilize-name").fill(uniqueFertilizer("多数"));
    await page.getByTestId("fertilize-amount").fill("0.25");
    // 単位の既定は前回の単位（他のテストの記録で変わる）なので明示する
    await page.getByTestId("fertilize-unit").selectOption("kg");
    await expect(page.getByTestId("fertilize-total")).toHaveText("25 kg");
    // 最後の行も上の量に追従している
    await expect(row(page, mats[99].code).getByTestId("fertilize-mat-amount")).toHaveValue("0.25");

    await page.getByTestId("fertilize-select-none").click();
    await expect(page.getByTestId("fertilize-count")).toHaveText("0");
    await expect(page.locator('[data-testid="fertilize-mat-row"][data-included="true"]')).toHaveCount(0);
    await page.getByTestId("fertilize-select-all").click();
    await expect(page.getByTestId("fertilize-count")).toHaveText("100");

    // 行の株コード（ラベル）をタップしてもチェックが切り替わる（タップ領域は行の高さ 48px）
    const label = row(page, mats[10].code).locator("label");
    expect((await label.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await label.click();
    await expect(row(page, mats[10].code).getByTestId("fertilize-mat-check")).not.toBeChecked();
    await label.click();
    await expect(row(page, mats[10].code).getByTestId("fertilize-mat-check")).toBeChecked();

    await row(page, mats[50].code).getByTestId("fertilize-mat-check").click();
    await row(page, mats[99].code).getByTestId("fertilize-mat-amount").fill("1");
    await expect(page.getByTestId("fertilize-count")).toHaveText("99");
    // 0.25 × 98 + 1 = 25.5
    await expect(page.getByTestId("fertilize-total")).toHaveText("25.5 kg");

    await confirmAndRecord(page, "99 株に合計 25.5 kg");
    const events = await fertilizedEvents(mats.map((m) => m.id));
    expect(events).toHaveLength(99);
    expect(new Set(events.map((e) => e.payload.batch_id)).size).toBe(1);
    expect(events.find((e) => e.target_id === mats[50].id)).toBeUndefined();
    expect(events.find((e) => e.target_id === mats[99].id)?.payload.amount).toBe(1);
  });
});
