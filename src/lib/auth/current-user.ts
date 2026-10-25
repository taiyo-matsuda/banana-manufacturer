import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { createClient } from "../supabase/server";
import { LOGIN_PATH } from "./redirect";

// 現在のユーザー（Server Component / Server Action 用）。
// React の cache() で包み、1 リクエストで getUser()（Supabase Auth へのネットワーク往復）を 1 回だけにする。
// 同じリクエストの中で何度呼んでも（Suspense 境界が別でも）同じ Promise を返す。
// ここでは getClaims ではなく getUser を使う: Auth サーバーでトークン（失効・ログアウト済みか）まで確かめる。
// proxy は毎リクエスト走るので getClaims（ローカルの署名検証）で軽くし、画面・Action で 1 回だけ getUser する（PERF-1）。
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

// 未ログインならログイン画面へ（画面と、redirect で返す Server Action 用）。
export async function requireUser(): Promise<User> {
  return userOrRedirect(await getCurrentUser());
}

// requireUser の判定部分。Promise.all で他の select と並べて取ったユーザーにも使う。
export function userOrRedirect(user: User | null): User {
  if (!user) redirect(LOGIN_PATH);
  return user;
}
