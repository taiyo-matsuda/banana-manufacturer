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
    return { error: "メールアドレスまたはパスワードが正しくありません", email };
  }
  redirect("/");
}

export async function logout(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
