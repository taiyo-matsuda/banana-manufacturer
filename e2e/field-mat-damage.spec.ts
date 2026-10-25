import type { Page } from "@playwright/test";
import { ACTION_TIMEOUT, expect, supabaseAsA, test } from "./helpers";
import { createField, fieldWithMats } from "./map-helpers";

// 2-5 圃場・株を対象にした被害。完了条件 1・2 を 1 つずつ検証し、加えて
// 圃場・株の被害で「喪失」が選べない（Server Action に直接 lost を送っても拒否され、入力が残る）/ 撤去した株には記録できず入力が残る /
// 一括で撤去済みの株が対象に出ない / 一括のイベントに field_event_id が入っている / 一括のサーバーのエラーで選択が残る /
// 圏外では保存できず理由が出る / target_type=field のイベントも E2E の掃除関数（0006）で消える、を確かめる。
// テスト農園 A でログイン済み（setup の storageState）。圃場・株は DB に直接作る（名前は E2E で始め、setup の掃除で消える）。

type DamageRow = {
  id: string;
  target_id: string;
  target_type: string;
  occurred_at: string;
  organization_id: string | null;
  note: string | null;
  payload: { kind: string; severity: string; field_event_id?: string; batch_id?: string };
};

async function damageEvents(targetType: "field" | "mat", targetIds: string[]): Promise<DamageRow[]> {
  const supabase = await supabaseAsA();
  const { data, error } = await supabase
    .from("events")
    .select("id, target_id, target_type, occurred_at, organization_id, note, payload")
    .eq("type", "damage")
    .eq("target_type", targetType)
    .in("target_id", targetIds);
  if (error) throw new Error(`イベントを読めません: ${error.message}`);
  return (data ?? []) as DamageRow[];
}

const todayJst = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
const todaySlash = () =>
  new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function uniqueNote(label: string) {
  return `E2E${label}-${test.info().project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

async function removeMat(matId: string) {
  const supabase = await supabaseAsA();
  const { error } = await supabase.rpc("remove_mat", {
    p_event_id: crypto.randomUUID(),
    p_mat_id: matId,
    p_occurred_at: new Date().toISOString(),
    p_reason: null,
  });
  expect(error).toBeNull();
}

// 「被害を記録」のダイアログを開いて入力する（保存はしない）
async function fillDamage(page: Page, values: { kind: string; severity: string; note?: string; date?: string }) {
  await page.getByTestId("damage-open").click();
  const dialog = page.getByTestId("damage-dialog");
  await expect(dialog).toBeVisible();
  // 日付の既定は今日
  await expect(page.getByTestId("damage-date")).toHaveValue(todayJst());
  if (values.date) await page.getByTestId("damage-date").fill(values.date);
  await page.getByTestId("damage-kind").selectOption(values.kind);
  await page.getByTestId("damage-severity").selectOption(values.severity);
  if (values.note !== undefined) await page.getByTestId("damage-note").fill(values.note);
  return dialog;
}

async function openFieldDetail(page: Page, fieldId: string) {
  await page.goto(`/fields/${fieldId}`);
  await expect(page.getByTestId("field-detail-name")).toBeVisible({ timeout: ACTION_TIMEOUT });
}

async function openMatDetail(page: Page, matId: string) {
  await page.goto(`/mats/${matId}`);
  await expect(page.getByTestId("mat-code")).toBeVisible({ timeout: ACTION_TIMEOUT });
}

// 圃場の被害を画面から記録し、完了の表示まで待つ。DB の圃場の被害イベントを返す
async function recordFieldDamage(page: Page, fieldId: string, values: { kind: string; severity: string; note?: string }) {
  await openFieldDetail(page, fieldId);
  await fillDamage(page, values);
  await page.getByTestId("damage-submit").click();
  await expect(page.getByTestId("damage-done")).toBeVisible({ timeout: ACTION_TIMEOUT });
  const events = await damageEvents("field", [fieldId]);
  expect(events).toHaveLength(1);
  return events[0];
}

const bulkRow = (page: Page, code: string) => page.locator(`[data-testid="damage-bulk-mat-row"][data-code="${code}"]`);

// Server Action の要求の本文の severity を書き換える（画面からは送れない値を直接送る）
async function rewriteSeverityOnce(page: Page, urlPattern: string, to: string) {
  let rewritten = 0;
  await page.route(urlPattern, async (route) => {
    const req = route.request();
    const body = req.postData() ?? "";
    if (rewritten === 0 && req.method() === "POST" && req.headers()["next-action"] && body.includes('"severity":')) {
      rewritten++;
      await route.continue({ postData: body.replace(/"severity":"[a-z]+"/, `"severity":"${to}"`) });
      return;
    }
    await route.continue();
  });
  return () => rewritten;
}

test.describe("圃場・株を対象にした被害", () => {
  test("完了条件 1: 圃場に被害を記録すると、圃場の詳細の「圃場の記録」に出る（種類・程度・メモ・日付）", async ({ page }) => {
    const field = await createField("E2E被害圃場");
    const note = uniqueNote("台風14号");
    await openFieldDetail(page, field.id);
    await expect(page.getByTestId("field-history").getByTestId("history-empty")).toBeVisible();

    await fillDamage(page, { kind: "lodging", severity: "severe", note });
    await page.getByTestId("damage-submit").click();
    await expect(page.getByTestId("damage-done")).toBeVisible({ timeout: ACTION_TIMEOUT });
    await page.getByTestId("damage-close").click();

    // 圃場の詳細の履歴に出る（画面の再読み込みなしで）
    const items = page.getByTestId("field-history").getByTestId("history-item");
    await expect(items).toHaveCount(1, { timeout: ACTION_TIMEOUT });
    await expect(items.nth(0)).toHaveAttribute("data-type", "damage");
    await expect(items.nth(0).getByTestId("history-label")).toHaveText("被害");
    await expect(items.nth(0).getByTestId("history-value")).toHaveText("倒伏・重");
    await expect(items.nth(0).getByTestId("history-note")).toHaveText(note);
    await expect(items.nth(0).getByTestId("history-at")).toContainText(todaySlash());

    // 再読み込みしても出る。削除・編集の操作はない（追記のみ）
    await page.reload();
    await expect(page.getByTestId("field-history").getByTestId("history-item")).toHaveCount(1);
    await expect(page.getByTestId("field-history").getByRole("button")).toHaveCount(0);

    // DB: target_type=field、payload は {kind, severity}、メモは note、organization_id はトリガーが入れる
    const [ev] = await damageEvents("field", [field.id]);
    expect(ev.payload).toEqual({ kind: "lodging", severity: "severe" });
    expect(ev.note).toBe(note);
    expect(ev.organization_id).toBeTruthy();
  });

  test("完了条件 1: 株に被害を記録すると、株の詳細の「株の記録」に出る（新しい順）", async ({ page }) => {
    const { mats } = await fieldWithMats("E2E被害株", 1);
    const mat = mats[0];
    await openMatDetail(page, mat.id);

    // 過去の日付で 1 件、今日で 1 件
    await fillDamage(page, { kind: "cold", severity: "light", date: "2026-10-01" });
    await page.getByTestId("damage-submit").click();
    await expect(page.getByTestId("damage-notice")).toHaveText("被害を記録しました", { timeout: ACTION_TIMEOUT });
    await expect(page.getByTestId("damage-dialog")).toHaveCount(0);
    const note = uniqueNote("株");
    await fillDamage(page, { kind: "disease", severity: "moderate", note });
    await page.getByTestId("damage-submit").click();
    await expect(page.getByTestId("damage-notice")).toBeVisible({ timeout: ACTION_TIMEOUT });

    const items = page.getByTestId("mat-history").getByTestId("history-item");
    await expect(items).toHaveCount(2, { timeout: ACTION_TIMEOUT });
    await expect(items.nth(0).getByTestId("history-value")).toHaveText("病害・中");
    await expect(items.nth(0).getByTestId("history-note")).toHaveText(note);
    await expect(items.nth(0).getByTestId("history-at")).toContainText(todaySlash());
    await expect(items.nth(1).getByTestId("history-value")).toHaveText("寒害・軽");
    await expect(items.nth(1).getByTestId("history-note")).toHaveCount(0);
    await expect(items.nth(1).getByTestId("history-at")).toContainText("2026/10/01");

    const events = await damageEvents("mat", [mat.id]);
    expect(events).toHaveLength(2);
    for (const e of events) expect(e.target_type).toBe("mat");
    expect(events.map((e) => e.payload).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: "cold", severity: "light" },
      { kind: "disease", severity: "moderate" },
    ]);
  });

  test("完了条件 2: 圃場の被害から複数の株に一括で記録でき、株ごとにイベントができる（外した株にはない）", async ({ page }) => {
    const { field, mats } = await fieldWithMats("E2E被害一括", 4);
    const note = uniqueNote("一括");
    const fieldEvent = await recordFieldDamage(page, field.id, { kind: "leaf_tear", severity: "moderate", note });

    // 保存の直後に「この圃場の株にも記録する」へ進める
    await page.getByTestId("damage-bulk-link").click();
    await expect(page).toHaveURL(`/fields/${field.id}/damage/${fieldEvent.id}`);
    await expect(page.getByTestId("damage-bulk-form")).toBeVisible({ timeout: ACTION_TIMEOUT });
    // 記録する内容（圃場の被害と同じ）
    await expect(page.getByTestId("damage-bulk-kind")).toHaveText("裂葉");
    await expect(page.getByTestId("damage-bulk-severity")).toHaveText("中");
    await expect(page.getByTestId("damage-bulk-note")).toHaveText(note);
    await expect(page.getByTestId("damage-bulk-date")).toHaveText(todayJst());

    // 既定は全株が対象（株コード順）。全て外す → 全て選択 → 1 株外す
    const rows = page.getByTestId("damage-bulk-mat-row");
    await expect(rows).toHaveCount(4);
    for (let i = 0; i < 4; i++) await expect(rows.nth(i)).toHaveAttribute("data-code", mats[i].code);
    await expect(page.getByTestId("damage-bulk-count")).toHaveText("4");
    await page.getByTestId("damage-bulk-select-none").click();
    await expect(page.getByTestId("damage-bulk-count")).toHaveText("0");
    await page.getByTestId("damage-bulk-submit").click();
    await expect(page.getByTestId("damage-bulk-confirm-dialog")).toHaveCount(0);
    await expect(page.getByTestId("damage-bulk-invalid")).toHaveText("対象の株を 1 株以上選んでください");
    await page.getByTestId("damage-bulk-select-all").click();
    await expect(page.getByTestId("damage-bulk-count")).toHaveText("4");
    await bulkRow(page, mats[2].code).getByTestId("damage-bulk-mat-check").click();
    await expect(bulkRow(page, mats[2].code)).toHaveAttribute("data-included", "false");
    await expect(page.getByTestId("damage-bulk-count")).toHaveText("3");
    // 行のタップ領域は 44px 以上
    expect((await bulkRow(page, mats[0].code).locator("label").boundingBox())!.height).toBeGreaterThanOrEqual(44);

    await page.getByTestId("damage-bulk-submit").click();
    await expect(page.getByTestId("damage-bulk-confirm-summary")).toHaveText("3 株に被害を記録");
    await page.getByTestId("damage-bulk-confirm-submit").click();
    await expect(page.getByTestId("damage-bulk-done")).toBeVisible({ timeout: ACTION_TIMEOUT });
    await expect(page.getByTestId("damage-bulk-done-summary")).toHaveText("3 株に記録しました");

    // DB: 選んだ 3 株に 1 件ずつ。同じ日付・種類・程度・メモ。外した株にはない
    const events = await damageEvents("mat", mats.map((m) => m.id));
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.target_id))).toEqual(new Set([mats[0].id, mats[1].id, mats[3].id]));
    for (const e of events) {
      expect(e.payload.kind).toBe("leaf_tear");
      expect(e.payload.severity).toBe("moderate");
      expect(e.note).toBe(note);
      expect(new Date(e.occurred_at).getTime()).toBe(new Date(fieldEvent.occurred_at).getTime());
      expect(e.organization_id).toBeTruthy();
    }

    // 各株の詳細の「株の記録」に出る。外した株には出ない
    await openMatDetail(page, mats[0].id);
    const item = page.getByTestId("mat-history").getByTestId("history-item");
    await expect(item).toHaveCount(1);
    await expect(item.getByTestId("history-value")).toHaveText("裂葉・中");
    await expect(item.getByTestId("history-note")).toHaveText(note);
    await openMatDetail(page, mats[2].id);
    await expect(page.getByTestId("mat-history").getByTestId("history-empty")).toBeVisible();

    // もう一度開くと、記録済みの株は候補に出ない（二重に記録しない）
    await page.goto(`/fields/${field.id}/damage/${fieldEvent.id}`);
    await expect(page.getByTestId("damage-bulk-mat-row")).toHaveCount(1);
    await expect(bulkRow(page, mats[2].code)).toBeVisible();
    await expect(page.getByTestId("damage-bulk-already")).toContainText("3 株");
  });

  test("一括のイベントの payload に圃場の被害イベントの id（field_event_id）と batch_id が入っている", async ({ page }) => {
    const { field, mats } = await fieldWithMats("E2E被害一括ID", 2);
    const fieldEvent = await recordFieldDamage(page, field.id, { kind: "break", severity: "light" });
    await page.getByTestId("damage-bulk-link").click();
    await expect(page.getByTestId("damage-bulk-form")).toBeVisible({ timeout: ACTION_TIMEOUT });
    await page.getByTestId("damage-bulk-submit").click();
    await page.getByTestId("damage-bulk-confirm-submit").click();
    await expect(page.getByTestId("damage-bulk-done")).toBeVisible({ timeout: ACTION_TIMEOUT });

    const events = await damageEvents("mat", mats.map((m) => m.id));
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.payload.field_event_id).toBe(fieldEvent.id);
      expect(e.payload.batch_id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(new Set(events.map((e) => e.payload.batch_id)).size).toBe(1);
    // メモなしの圃場の被害からは note も null
    for (const e of events) expect(e.note).toBeNull();
  });

  test("一括の対象に撤去した株は出ない", async ({ page }) => {
    const { field, mats } = await fieldWithMats("E2E被害一括撤去", 3);
    await removeMat(mats[1].id);
    const fieldEvent = await recordFieldDamage(page, field.id, { kind: "lodging", severity: "light" });
    await page.goto(`/fields/${field.id}/damage/${fieldEvent.id}`);
    await expect(page.getByTestId("damage-bulk-mat-row")).toHaveCount(2);
    await expect(bulkRow(page, mats[0].code)).toBeVisible();
    await expect(bulkRow(page, mats[2].code)).toBeVisible();
    await expect(bulkRow(page, mats[1].code)).toHaveCount(0);
    await expect(page.getByTestId("damage-bulk-summary")).toContainText("/ 2 株");
  });

  test("圃場・株の被害では「喪失」を選べず、案内が出る", async ({ page }) => {
    const { field, mats } = await fieldWithMats("E2E被害喪失なし", 1);
    for (const open of [() => openFieldDetail(page, field.id), () => openMatDetail(page, mats[0].id)]) {
      await open();
      await page.getByTestId("damage-open").click();
      const severity = page.getByTestId("damage-severity");
      await expect(severity.locator("option")).toHaveText(["選んでください", "軽", "中", "重"]);
      await expect(severity.locator('option[value="lost"]')).toHaveCount(0);
      await expect(page.getByTestId("damage-dialog")).toContainText("「喪失」は選べません");
      await expect(page.getByTestId("damage-dialog")).toContainText("株の撤去");
      await page.getByTestId("damage-cancel").click();
    }
  });

  test("Server Action に直接 lost を送っても拒否され、記録されない。入力は残る（圃場）", async ({ page }) => {
    const field = await createField("E2E被害lost圃場");
    await openFieldDetail(page, field.id);
    const note = uniqueNote("lost");
    await fillDamage(page, { kind: "lodging", severity: "severe", note });
    const rewritten = await rewriteSeverityOnce(page, `**/fields/${field.id}`, "lost");
    await page.getByTestId("damage-submit").click();
    await expect(page.getByTestId("damage-severity-error")).toContainText("「喪失」は記録できません", { timeout: ACTION_TIMEOUT });
    expect(rewritten()).toBe(1);

    // ダイアログは開いたまま、入力が残る（React 19 のフォームリセットを受けない）
    await expect(page.getByTestId("damage-dialog")).toBeVisible();
    await expect(page.getByTestId("damage-kind")).toHaveValue("lodging");
    await expect(page.getByTestId("damage-severity")).toHaveValue("severe");
    await expect(page.getByTestId("damage-note")).toHaveValue(note);
    await expect(page.getByTestId("damage-date")).toHaveValue(todayJst());
    expect(await damageEvents("field", [field.id])).toHaveLength(0);

    // そのまま送り直すと（書き換えなし）記録される
    await page.getByTestId("damage-submit").click();
    await expect(page.getByTestId("damage-done")).toBeVisible({ timeout: ACTION_TIMEOUT });
    const events = await damageEvents("field", [field.id]);
    expect(events).toHaveLength(1);
    expect(events[0].payload.severity).toBe("severe");
  });

  test("Server Action に直接 lost を送っても拒否される（株）", async ({ page }) => {
    const { mats } = await fieldWithMats("E2E被害lost株", 1);
    await openMatDetail(page, mats[0].id);
    await fillDamage(page, { kind: "break", severity: "moderate" });
    const rewritten = await rewriteSeverityOnce(page, `**/mats/${mats[0].id}`, "lost");
    await page.getByTestId("damage-submit").click();
    await expect(page.getByTestId("damage-severity-error")).toContainText("「喪失」は記録できません", { timeout: ACTION_TIMEOUT });
    expect(rewritten()).toBe(1);
    await expect(page.getByTestId("damage-severity")).toHaveValue("moderate");
    expect(await damageEvents("mat", [mats[0].id])).toHaveLength(0);
  });

  test("画面を開いた後に撤去された株には記録できず、理由が出て入力が残る", async ({ page }) => {
    const { mats } = await fieldWithMats("E2E被害撤去後", 1);
    await openMatDetail(page, mats[0].id);
    const note = uniqueNote("撤去後");
    await fillDamage(page, { kind: "lodging", severity: "light", note });
    await removeMat(mats[0].id);
    await page.getByTestId("damage-submit").click();
    await expect(page.getByTestId("damage-error")).toHaveText("撤去した株には被害を記録できません", { timeout: ACTION_TIMEOUT });
    await expect(page.getByTestId("damage-kind")).toHaveValue("lodging");
    await expect(page.getByTestId("damage-severity")).toHaveValue("light");
    await expect(page.getByTestId("damage-note")).toHaveValue(note);
    expect(await damageEvents("mat", [mats[0].id])).toHaveLength(0);

    // 撤去済みの株の詳細には「被害を記録」が出ない
    await page.reload();
    await expect(page.getByTestId("mat-removed")).toBeVisible();
    await expect(page.getByTestId("damage-open")).toHaveCount(0);
  });

  test("一括でサーバーのエラーで戻っても選択が残り、何も記録されない", async ({ page }) => {
    const { field, mats } = await fieldWithMats("E2E被害一括エラー", 3);
    const fieldEvent = await recordFieldDamage(page, field.id, { kind: "cold", severity: "severe" });
    await page.goto(`/fields/${field.id}/damage/${fieldEvent.id}`);
    await expect(page.getByTestId("damage-bulk-form")).toBeVisible({ timeout: ACTION_TIMEOUT });
    await bulkRow(page, mats[0].code).getByTestId("damage-bulk-mat-check").click();

    // 画面を開いた後に、対象の株（2 番目）が別の経路で撤去された
    await removeMat(mats[1].id);
    await page.getByTestId("damage-bulk-submit").click();
    await page.getByTestId("damage-bulk-confirm-submit").click();
    await expect(page.getByTestId("damage-bulk-invalid")).toContainText("撤去した株が含まれています", { timeout: ACTION_TIMEOUT });
    await expect(bulkRow(page, mats[0].code)).toHaveAttribute("data-included", "false");
    await expect(bulkRow(page, mats[1].code)).toHaveAttribute("data-included", "true");
    await expect(page.getByTestId("damage-bulk-count")).toHaveText("2");
    expect(await damageEvents("mat", mats.map((m) => m.id))).toHaveLength(0);
  });

  test("一括で応答が届かずに同じ内容で再送しても二重に記録されない", async ({ page }) => {
    const { field, mats } = await fieldWithMats("E2E被害一括再送", 2);
    const fieldEvent = await recordFieldDamage(page, field.id, { kind: "lodging", severity: "moderate" });
    await page.goto(`/fields/${field.id}/damage/${fieldEvent.id}`);
    await expect(page.getByTestId("damage-bulk-form")).toBeVisible({ timeout: ACTION_TIMEOUT });

    // 1 回目の Server Action だけ、サーバーには届けて（insert される）応答を端末に返さない
    let dropped = 0;
    await page.route(`**/fields/${field.id}/damage/${fieldEvent.id}`, async (route) => {
      const req = route.request();
      if (dropped === 0 && req.method() === "POST" && req.headers()["next-action"]) {
        dropped++;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.getByTestId("damage-bulk-submit").click();
    await page.getByTestId("damage-bulk-confirm-submit").click();
    await expect(page.getByTestId("damage-bulk-error")).toContainText("保存できませんでした", { timeout: ACTION_TIMEOUT });
    expect(dropped).toBe(1);
    await expect.poll(async () => (await damageEvents("mat", mats.map((m) => m.id))).length).toBe(2);

    // 確認ダイアログを開き直して再送 → 同じ batch_id なので件数は増えない
    await page.getByTestId("damage-bulk-submit").click();
    await page.getByTestId("damage-bulk-confirm-submit").click();
    await expect(page.getByTestId("damage-bulk-done")).toBeVisible({ timeout: ACTION_TIMEOUT });
    const events = await damageEvents("mat", mats.map((m) => m.id));
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.payload.batch_id)).size).toBe(1);
  });

  test("圃場の被害で応答が届かずに再送しても二重に記録されない", async ({ page }) => {
    const field = await createField("E2E被害圃場再送");
    await openFieldDetail(page, field.id);
    await fillDamage(page, { kind: "disease", severity: "light" });
    let dropped = 0;
    await page.route(`**/fields/${field.id}`, async (route) => {
      const req = route.request();
      if (dropped === 0 && req.method() === "POST" && req.headers()["next-action"]) {
        dropped++;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.getByTestId("damage-submit").click();
    await expect(page.getByTestId("damage-error")).toContainText("保存できませんでした", { timeout: ACTION_TIMEOUT });
    await expect.poll(async () => (await damageEvents("field", [field.id])).length).toBe(1);
    await page.getByTestId("damage-submit").click();
    await expect(page.getByTestId("damage-done")).toBeVisible({ timeout: ACTION_TIMEOUT });
    expect(await damageEvents("field", [field.id])).toHaveLength(1);
  });

  test("圏外では保存ボタンが無効になり、理由が出る（圃場の被害・一括）", async ({ page, context }) => {
    const { field } = await fieldWithMats("E2E被害圏外", 1);
    const fieldEvent = await recordFieldDamage(page, field.id, { kind: "lodging", severity: "light" });
    await page.getByTestId("damage-close").click();

    await page.getByTestId("damage-open").click();
    await expect(page.getByTestId("damage-submit")).toBeEnabled();
    await context.setOffline(true);
    try {
      await expect(page.getByTestId("damage-submit")).toBeDisabled();
      await expect(page.getByTestId("damage-offline")).toContainText("電波のあるところ");
    } finally {
      await context.setOffline(false);
    }
    await expect(page.getByTestId("damage-submit")).toBeEnabled();
    await page.getByTestId("damage-cancel").click();

    await page.goto(`/fields/${field.id}/damage/${fieldEvent.id}`);
    await expect(page.getByTestId("damage-bulk-submit")).toBeEnabled({ timeout: ACTION_TIMEOUT });
    await context.setOffline(true);
    try {
      await expect(page.getByTestId("damage-bulk-submit")).toBeDisabled();
      await expect(page.getByTestId("damage-bulk-offline")).toContainText("電波のあるところ");
    } finally {
      await context.setOffline(false);
    }
  });

  test("target_type=field の被害イベントも E2E の掃除関数（0006）で消える", async ({ page }) => {
    const { field, mats } = await fieldWithMats("E2E被害掃除", 1);
    const fieldEvent = await recordFieldDamage(page, field.id, { kind: "lodging", severity: "moderate" });
    const supabase = await supabaseAsA();
    // 圃場名で絞って掃除する（他のテストの圃場は消さない）
    const { data: f } = await supabase.from("fields").select("name").eq("id", field.id).single();
    const { data: deleted, error } = await supabase.rpc("e2e_cleanup_fields", { prefix: f!.name as string });
    expect(error).toBeNull();
    expect(deleted).toBe(1);
    const { data: left } = await supabase.from("events").select("id").eq("id", fieldEvent.id);
    expect(left ?? []).toHaveLength(0);
    const { data: mat } = await supabase.from("mats").select("id").eq("id", mats[0].id);
    expect(mat ?? []).toHaveLength(0);
  });
});
