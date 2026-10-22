import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { accountA, accountB, env, login, submitLogin } from "./helpers";

// タスク 1-1 Supabase 接続と認証。完了条件 1〜6 を1つずつ検証する。

test("1. 未ログインで / を開くと /login に遷移する", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL("/login");
  await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
  await expect(page.getByLabel("メールアドレス")).toBeVisible();
  await expect(page.getByLabel("パスワード")).toBeVisible();
});

test("2. 正しいメール・パスワードでログインすると / に遷移し、組織名が表示される", async ({
  page,
}) => {
  const a = accountA();
  await login(page, a.email, a.password);
  const orgName = page.getByTestId("organization-name");
  await expect(orgName).toBeVisible();
  await expect(orgName).not.toHaveText("");
  await expect(orgName).not.toHaveText("（組織が未設定）");
  // ログイン後は /login を開いてもホームに戻される
  await page.goto("/login");
  await expect(page).toHaveURL("/");
});

test("3. 誤ったパスワードではエラーが表示され、遷移しない", async ({ page }) => {
  const a = accountA();
  await submitLogin(page, a.email, a.password + "_wrong");
  const alert = page.getByTestId("login-error");
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("正しくありません");
  await expect(page).toHaveURL("/login");
  // 入力した値が残っており、やり直せる
  await expect(page.getByLabel("メールアドレス")).toHaveValue(a.email);
  // 未ログインのままなので / は開けない
  await page.goto("/");
  await expect(page).toHaveURL("/login");
});

test("4. 画面のどこにも Sign Up の導線がない", async ({ page }) => {
  const a = accountA();
  const signUpPattern = /sign ?up|新規登録|アカウント(を)?作成|会員登録|register/i;

  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(signUpPattern);
  await expect(page.getByRole("link", { name: signUpPattern })).toHaveCount(0);
  await expect(page.getByRole("button", { name: signUpPattern })).toHaveCount(0);
  await expect(page.locator('a[href*="signup"], a[href*="sign-up"], a[href*="register"]')).toHaveCount(0);

  await login(page, a.email, a.password);
  await expect(page.getByTestId("organization-name")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(signUpPattern);
  await expect(page.getByRole("link", { name: signUpPattern })).toHaveCount(0);
  await expect(page.getByRole("button", { name: signUpPattern })).toHaveCount(0);
});

test("5. テスト用アカウント A でログインでき、組織名「テスト農園A」が表示される", async ({
  page,
}) => {
  const a = accountA();
  await login(page, a.email, a.password);
  await expect(page.getByTestId("organization-name")).toHaveText("テスト農園A");
  // 再読み込みしてもセッションが保持される
  await page.reload();
  await expect(page).toHaveURL("/");
  await expect(page.getByTestId("organization-name")).toHaveText("テスト農園A");
});

test("6. 組織の分離: B では「テスト農園B」が表示され、A の fields が見えない", async ({
  page,
}) => {
  const a = accountA();
  const b = accountB();
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const key = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  // A として fields を 1 件 insert する（organization_id は渡さない。トリガーが補う）
  const supabaseA = createClient(url, key, { auth: { persistSession: false } });
  const signInA = await supabaseA.auth.signInWithPassword({ email: a.email, password: a.password });
  expect(signInA.error).toBeNull();
  // 2 つのプロジェクト（iphone / desktop）が並行して走るので、名前が衝突しないようにする
  const fieldName = `E2E圃場-${test.info().project.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inserted = await supabaseA
    .from("fields")
    .insert({ name: fieldName, center_lat: 26.5, center_lng: 127.9 })
    .select("id, organization_id, name")
    .single();
  expect(inserted.error).toBeNull();
  expect(inserted.data?.organization_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  const fieldsA = await supabaseA.from("fields").select("id");
  expect(fieldsA.error).toBeNull();
  expect(fieldsA.data!.length).toBeGreaterThanOrEqual(1);

  // B として select すると 0 件
  const supabaseB = createClient(url, key, { auth: { persistSession: false } });
  const signInB = await supabaseB.auth.signInWithPassword({ email: b.email, password: b.password });
  expect(signInB.error).toBeNull();
  const fieldsB = await supabaseB.from("fields").select("id");
  expect(fieldsB.error).toBeNull();
  expect(fieldsB.data).toHaveLength(0);
  // id を直接指定しても見えない
  const byIdB = await supabaseB.from("fields").select("id").eq("id", inserted.data!.id);
  expect(byIdB.error).toBeNull();
  expect(byIdB.data).toHaveLength(0);

  // 画面でも B の組織名が表示される
  await login(page, b.email, b.password);
  await expect(page.getByTestId("organization-name")).toHaveText("テスト農園B");
});
