import type { Page } from "@playwright/test";
import { distanceM, offsetLatLng } from "../src/lib/geo";
import { ACTION_TIMEOUT, expect, test } from "./helpers";
import { canvasCenter, CENTER, createField, createMat, createStem, dragBy, openMap, readLatLng } from "./map-helpers";

// 2-3 株の位置の修正と撤去。完了条件 1・2 を 1 つずつ検証し、加えて
// 「取り消し」で位置が変わらない / モード外ではドラッグしても位置が変わらない / 吸芽がある株も撤去できない /
// 撤去した株のコードは次の採番で再利用されない / 撤去した株も E2E の掃除で消える、を確かめる。
// テスト農園 A でログイン済み（setup の storageState）。圃場・株・茎は DB に直接作る（名前は E2E で始め、setup の掃除で消える）。

// 東へ 5m 間隔で 3 株（地図の上で 1 株ずつ掴めるように離す）
async function fieldWithThreeMats(prefix: string) {
  const field = await createField(prefix);
  const positions = [0, 5, 10].map((d) => offsetLatLng(CENTER, 90, d));
  const codes = [1, 2, 3].map((n) => `${field.code}-00${n}`);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push(await createMat(field.id, codes[i], "2026-09-15", positions[i]));
  return { field, positions, codes, ids };
}

const marker = (page: Page, code: string) => page.locator(`[data-testid="mat-marker"][data-code="${code}"]`);

async function dbPosition(field: Awaited<ReturnType<typeof createField>>, matId: string) {
  const { data, error } = await field.supabase.from("mats").select("lat, lng").eq("id", matId).single();
  if (error || !data) throw new Error(`株を読めません: ${error?.message}`);
  return { lat: data.lat as number, lng: data.lng as number };
}

async function matRow(field: Awaited<ReturnType<typeof createField>>, matId: string) {
  const { data, error } = await field.supabase.from("mats").select("status, code").eq("id", matId).single();
  if (error || !data) throw new Error(`株を読めません: ${error?.message}`);
  return data as { status: string; code: string };
}

async function matRemovedEvents(field: Awaited<ReturnType<typeof createField>>, matId: string) {
  const { data, error } = await field.supabase
    .from("events")
    .select("id, type, target_type, payload, organization_id")
    .eq("target_type", "mat")
    .eq("target_id", matId)
    .eq("type", "mat_removed");
  if (error) throw new Error(`イベントを読めません: ${error.message}`);
  return data ?? [];
}

function todayJst() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(),
  );
}

async function openEdit(page: Page, matId: string) {
  await page.goto(`/mats/${matId}`);
  await page.getByTestId("mat-edit-link").click();
  await expect(page).toHaveURL(`/mats/${matId}/edit`);
  await expect(page.getByTestId("mat-edit-form")).toBeVisible();
}

test.describe("位置の修正", () => {
  test("完了条件 1: 株を 1 つドラッグして確定すると、再読み込み後も新しい位置にある。他の株は動かない", async ({ page }) => {
    const { field, positions, codes, ids } = await fieldWithThreeMats("E2E位置修正");
    const map = await openMap(page, field.id);
    await expect(page.getByTestId("mat-marker")).toHaveCount(3);

    await page.getByTestId("relocate-start").click();
    await expect(map).toHaveAttribute("data-mode", "relocate");
    await expect(page.getByTestId("place-status")).toContainText("ドラッグ");
    await expect(page.getByTestId("relocate-confirm")).toBeDisabled();

    // 2 番目の株を下へ 50px ドラッグ
    await map.scrollIntoViewIfNeeded();
    await dragBy(page, marker(page, codes[1]), 0, 50);

    // 動かした株は見た目で分かる（data-moved）。他の株は印が付かない
    await expect(marker(page, codes[1])).toHaveAttribute("data-moved", "true");
    await expect(marker(page, codes[0])).not.toHaveAttribute("data-moved", "true");
    await expect(marker(page, codes[2])).not.toHaveAttribute("data-moved", "true");
    await expect(page.getByTestId("relocate-moved-count")).toHaveText("動かした株 1");
    const dragged = await readLatLng(marker(page, codes[1]));
    expect(distanceM(dragged, positions[1])).toBeGreaterThan(1);

    await page.getByTestId("relocate-confirm").click();
    await expect(page.getByTestId("place-notice")).toHaveText("1 株の位置を直しました", { timeout: ACTION_TIMEOUT });
    await expect(map).toHaveAttribute("data-mode", "idle");

    // DB: 動かした株だけ新しい位置。他の株は元の位置のまま
    expect(distanceM(await dbPosition(field, ids[1]), dragged)).toBeLessThan(0.01);
    expect(distanceM(await dbPosition(field, ids[0]), positions[0])).toBeLessThan(0.01);
    expect(distanceM(await dbPosition(field, ids[2]), positions[2])).toBeLessThan(0.01);

    // 再読み込み後も新しい位置にある（他の株は動かない）
    await page.reload();
    await expect(map).toHaveAttribute("data-map-ready", "true", { timeout: ACTION_TIMEOUT });
    await expect(page.getByTestId("mat-marker")).toHaveCount(3);
    expect(distanceM(await readLatLng(marker(page, codes[1])), dragged)).toBeLessThan(0.01);
    expect(distanceM(await readLatLng(marker(page, codes[0])), positions[0])).toBeLessThan(0.01);
    expect(distanceM(await readLatLng(marker(page, codes[2])), positions[2])).toBeLessThan(0.01);
    await expect(marker(page, codes[1])).not.toHaveAttribute("data-moved", "true");
  });

  test("「取り消し」すると位置は変わらない", async ({ page }) => {
    const { field, positions, codes, ids } = await fieldWithThreeMats("E2E位置取消");
    const map = await openMap(page, field.id);
    await page.getByTestId("relocate-start").click();
    await map.scrollIntoViewIfNeeded();
    await dragBy(page, marker(page, codes[0]), 40, 40);
    await expect(marker(page, codes[0])).toHaveAttribute("data-moved", "true");
    expect(distanceM(await readLatLng(marker(page, codes[0])), positions[0])).toBeGreaterThan(1);

    await page.getByTestId("relocate-cancel").click();
    await expect(map).toHaveAttribute("data-mode", "idle");
    // 点は元の位置に戻る
    await expect(marker(page, codes[0])).not.toHaveAttribute("data-moved", "true");
    expect(distanceM(await readLatLng(marker(page, codes[0])), positions[0])).toBeLessThan(0.01);
    // DB は変わっていない（再読み込みしても元の位置）
    expect(distanceM(await dbPosition(field, ids[0]), positions[0])).toBeLessThan(0.01);
    await page.reload();
    await expect(map).toHaveAttribute("data-map-ready", "true", { timeout: ACTION_TIMEOUT });
    expect(distanceM(await readLatLng(marker(page, codes[0])), positions[0])).toBeLessThan(0.01);
  });

  test("モード外では株の点をドラッグしても位置が変わらない", async ({ page }) => {
    const { field, positions, codes, ids } = await fieldWithThreeMats("E2E位置モード外");
    const map = await openMap(page, field.id);
    await expect(map).toHaveAttribute("data-mode", "idle");
    await map.scrollIntoViewIfNeeded();
    const before = await readLatLng(marker(page, codes[2]));
    await dragBy(page, marker(page, codes[2]), 0, 50);

    // 点を動かす操作にならない（地図のパンかタップとして扱われる。株の座標は変わらない）
    if (page.url().endsWith(`/fields/${field.id}/map`)) {
      await expect(marker(page, codes[2])).not.toHaveAttribute("data-moved", "true");
      expect(distanceM(await readLatLng(marker(page, codes[2])), before)).toBeLessThan(0.01);
    }
    expect(distanceM(await dbPosition(field, ids[2]), positions[2])).toBeLessThan(0.01);
    await page.goto(`/fields/${field.id}/map`);
    await expect(map).toHaveAttribute("data-map-ready", "true", { timeout: ACTION_TIMEOUT });
    expect(distanceM(await readLatLng(marker(page, codes[2])), positions[2])).toBeLessThan(0.01);
  });
});

test.describe("撤去", () => {
  test("完了条件 2a: 撤去した株は地図から消え、株の詳細は「撤去済み」（日付・理由）。記録・編集のボタンが出ない", async ({
    page,
  }) => {
    const { field, codes, ids } = await fieldWithThreeMats("E2E撤去");
    // 終わった茎（収穫済み）だけの株は撤去できる
    await createStem(ids[1], { status: "harvested" });

    await openEdit(page, ids[1]);
    await expect(page.getByTestId("mat-remove-blocked")).toHaveCount(0);
    await page.getByTestId("mat-remove-open").click();
    const dialog = page.getByTestId("mat-remove-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`株 ${codes[1]} を撤去しますか？`);
    // 「やめる」では撤去しない
    await dialog.getByTestId("mat-remove-cancel").click();
    await expect(dialog).toHaveCount(0);
    expect((await matRow(field, ids[1])).status).toBe("active");

    await page.getByTestId("mat-remove-open").click();
    await page.getByTestId("mat-remove-reason").fill("台風で倒れた");
    await page.getByTestId("mat-remove-submit").click();

    // 株の詳細（撤去済み）へ戻る
    await expect(page).toHaveURL(`/mats/${ids[1]}`, { timeout: ACTION_TIMEOUT });
    await expect(page.getByTestId("mat-removed")).toHaveText(`撤去済み（${todayJst()}・台風で倒れた）`);
    await expect(page.getByTestId("mat-code")).toHaveText(codes[1]);
    await expect(page.getByTestId("mat-edit-link")).toHaveCount(0);
    await expect(page.getByTestId("stem-form")).toHaveCount(0);
    await expect(page.getByTestId("stem-add")).toHaveCount(0);
    await expect(page.getByTestId("sucker-open")).toHaveCount(0);
    // 茎（収穫済み）は既存どおり一覧に出る
    await expect(page.getByTestId("stem-item")).toHaveCount(1);

    // DB: status=removed と mat_removed イベント（payload.reason。organization_id はトリガーがコピー）
    expect((await matRow(field, ids[1])).status).toBe("removed");
    const events = await matRemovedEvents(field, ids[1]);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ reason: "台風で倒れた" });
    expect(events[0].organization_id).toBeTruthy();

    // 地図から消える（他の株は残る）
    const map = await openMap(page, field.id);
    await expect(page.getByTestId("mat-marker")).toHaveCount(2);
    await expect(marker(page, codes[1])).toHaveCount(0);
    await expect(page.getByTestId("mat-count")).toHaveText("株 2");
    await expect(map).toHaveAttribute("data-map-ready", "true");

    // ホームの「最近開いた株」にも出ない（撤去前に開いていても外れる）
    await page.goto("/");
    await expect(page.getByTestId("recent-mats")).toBeVisible();
    await expect(page.getByTestId("recent-mat-row").filter({ hasText: codes[1] })).toHaveCount(0);

    // 撤去済みの株の編集画面は編集できない
    await page.goto(`/mats/${ids[1]}/edit`);
    await expect(page.getByTestId("mat-edit-removed")).toBeVisible();
    await expect(page.getByTestId("mat-edit-form")).toHaveCount(0);
  });

  test("完了条件 2b: 栽培中の茎がある株は撤去できない（理由を表示。DB も拒否する）", async ({ page }) => {
    const { field, ids } = await fieldWithThreeMats("E2E撤去不可");
    await createStem(ids[0], { status: "active" });

    await openEdit(page, ids[0]);
    await expect(page.getByTestId("mat-remove-open")).toBeDisabled();
    await expect(page.getByTestId("mat-remove-blocked")).toHaveText(
      "栽培中の茎があるため撤去できません。先に収穫・喪失などで茎を終えてください",
    );

    // 画面を通さず RPC を呼んでも拒否される（正本は DB）
    const { error } = await field.supabase.rpc("remove_mat", {
      p_event_id: crypto.randomUUID(),
      p_mat_id: ids[0],
      p_occurred_at: new Date().toISOString(),
      p_reason: null,
    });
    expect(error?.message).toBe("栽培中の茎があるため撤去できません。先に収穫・喪失などで茎を終えてください");
    expect((await matRow(field, ids[0])).status).toBe("active");
    expect(await matRemovedEvents(field, ids[0])).toHaveLength(0);

    // 出蕾済み（flowered）の茎も栽培中
    await createStem(ids[2], { status: "flowered" });
    await openEdit(page, ids[2]);
    await expect(page.getByTestId("mat-remove-open")).toBeDisabled();

    // 地図には残る
    await openMap(page, field.id);
    await expect(page.getByTestId("mat-marker")).toHaveCount(3);
  });

  test("吸芽がある株も撤去できない（芽かき・株分け・採用を先に決める）", async ({ page }) => {
    const { field, ids } = await fieldWithThreeMats("E2E撤去吸芽");
    // 親茎は収穫済み、吸芽が 1 本残っている
    const parent = await createStem(ids[0], { status: "harvested" });
    await createStem(ids[0], { status: "sucker", generation: 2, parentStemId: parent });

    await openEdit(page, ids[0]);
    await expect(page.getByTestId("mat-remove-open")).toBeDisabled();
    await expect(page.getByTestId("mat-remove-blocked")).toHaveText(
      "未処理の吸芽があるため撤去できません。先に吸芽の芽かき・株分け・採用を決めてください",
    );

    const { error } = await field.supabase.rpc("remove_mat", {
      p_event_id: crypto.randomUUID(),
      p_mat_id: ids[0],
      p_occurred_at: new Date().toISOString(),
      p_reason: "test",
    });
    expect(error?.message).toBe("未処理の吸芽があるため撤去できません。先に吸芽の芽かき・株分け・採用を決めてください");
    expect((await matRow(field, ids[0])).status).toBe("active");
  });

  test("撤去は p_event_id で冪等（同じ確定を二重に送ってもイベントは 1 件）", async () => {
    const { field, ids } = await fieldWithThreeMats("E2E撤去冪等");
    const eventId = crypto.randomUUID();
    const args = { p_event_id: eventId, p_mat_id: ids[0], p_occurred_at: new Date().toISOString(), p_reason: " " };
    const first = await field.supabase.rpc("remove_mat", args);
    expect(first.error).toBeNull();
    const second = await field.supabase.rpc("remove_mat", args);
    expect(second.error).toBeNull();
    const events = await matRemovedEvents(field, ids[0]);
    expect(events).toHaveLength(1);
    // 空白だけの理由は null
    expect(events[0].payload).toEqual({ reason: null });
    // 別の id で撤去済みの株をもう一度撤去しようとすると拒否
    const again = await field.supabase.rpc("remove_mat", { ...args, p_event_id: crypto.randomUUID() });
    expect(again.error?.message).toBe("この株は既に撤去済みです");
  });

  test("撤去した株のコードは次の採番で再利用されない（1株追加）", async ({ page }) => {
    const { field, codes, ids } = await fieldWithThreeMats("E2E撤去採番");
    // 最大番号の株（-003）を撤去する
    const { error } = await field.supabase.rpc("remove_mat", {
      p_event_id: crypto.randomUUID(),
      p_mat_id: ids[2],
      p_occurred_at: new Date().toISOString(),
      p_reason: null,
    });
    expect(error).toBeNull();

    const map = await openMap(page, field.id);
    await expect(page.getByTestId("mat-marker")).toHaveCount(2);
    await page.getByRole("button", { name: "1株追加" }).click();
    await expect(map).toHaveAttribute("data-mode", "pick-single");
    // 既存の株から離れた位置（地図の中心から上へ）をタップ
    const c = await canvasCenter(map);
    await page.mouse.click(c.x, c.y - 80);
    await expect(map).toHaveAttribute("data-mode", "single-form");
    await page.getByTestId("single-confirm").click();

    const next = `${field.code}-004`;
    await expect(page.getByTestId("place-notice")).toHaveText(`株 ${next} を追加しました`, { timeout: ACTION_TIMEOUT });
    await expect(marker(page, next)).toHaveCount(1);
    await expect(marker(page, codes[2])).toHaveCount(0);
    // DB: -003 は撤去済みのまま 1 行だけ（再利用されていない）
    const { data } = await field.supabase.from("mats").select("code, status").eq("field_id", field.id).order("code");
    expect(data).toEqual([
      { code: codes[0], status: "active" },
      { code: codes[1], status: "active" },
      { code: codes[2], status: "removed" },
      { code: next, status: "active" },
    ]);
  });

  test("撤去した株も E2E の掃除（e2e_cleanup_fields）で消える", async () => {
    const field = await createField("E2E撤去掃除");
    const { data: f } = await field.supabase.from("fields").select("name").eq("id", field.id).single();
    const matId = await createMat(field.id, `${field.code}-001`);
    await createStem(matId, { status: "harvested" });
    const { error } = await field.supabase.rpc("remove_mat", {
      p_event_id: crypto.randomUUID(),
      p_mat_id: matId,
      p_occurred_at: new Date().toISOString(),
      p_reason: "掃除の確認",
    });
    expect(error).toBeNull();
    expect(await matRemovedEvents(field, matId)).toHaveLength(1);

    // この圃場の名前だけを prefix にして掃除する（他のテストの圃場は消さない）
    const { data: deleted, error: cleanupError } = await field.supabase.rpc("e2e_cleanup_fields", { prefix: f!.name });
    expect(cleanupError).toBeNull();
    expect(deleted).toBe(1);
    const { data: mats } = await field.supabase.from("mats").select("id").eq("id", matId);
    expect(mats).toEqual([]);
    expect(await matRemovedEvents(field, matId)).toHaveLength(0);
  });
});
