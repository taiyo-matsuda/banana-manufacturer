import "server-only";

import { cache } from "react";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { supabaseEnv } from "./env";

// サーバー用クライアント（Server Component / Server Action / Route Handler）。
// cookies() を読むので、呼び出し元は Suspense 境界の内側か Server Action に限る。
// React の cache() で 1 リクエスト 1 つにする（PERF-1）。同じリクエストの画面・部品・getCurrentUser が
// 同じクライアント（同じ Cookie のセッション）を使う。cache() の範囲はリクエストごとなので、別のリクエストとは共有しない。
export const createClient = cache(async () => {
  // Supabase の auth クライアントは生成時に Date.now() を読む。プリレンダー中に評価されないよう
  // 先にリクエスト到着を待つ（Cache Components の "blocking-prerender-current-time" 対策）
  await connection();
  const { url, key } = supabaseEnv();
  const cookieStore = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component からは Cookie を書けない。proxy がセッションを更新するので無視してよい。
        }
      },
    },
  });
});
