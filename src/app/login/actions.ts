"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// email は失敗時にフォームへ戻すために返す（パスワードは返さない）
export type LoginState = { error: string | null; email: string };

export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) {
    return { error: "メールアドレスとパスワードを入力してください", email };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // 認証情報の誤り以外（API キーの不一致、URL の誤りなど設定の問題）は区別して見せる。
    // 本番（Vercel）の環境変数の設定ミスを「パスワードが違う」と誤認しないため。
    const invalidCredentials = /invalid login credentials/i.test(error.message);
    if (!invalidCredentials) {
      console.error("login: supabase auth error", error.status, error.message);
      return {
        error: `ログインできませんでした（設定の問題の可能性があります: ${error.message}）`,
        email,
      };
    }
    return { error: "メールアドレスまたはパスワードが正しくありません", email };
  }
  redirect("/");
}

export async function logout(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
