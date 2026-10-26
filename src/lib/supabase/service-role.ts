import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// service_role（Secret key）のクライアント。RLS を通らず全組織の行を読み書きできる。
// 使ってよいのは気温の日次取り込み（Cron の Route Handler src/app/api/cron/weather/route.ts）だけ
// （architecture.md 2・7 章の例外）。画面・Server Action・クライアントに渡るコードから import しない。
// キーはサーバー側の環境変数 SUPABASE_SERVICE_ROLE_KEY からだけ読む（NEXT_PUBLIC_ を付けない。ブラウザに出ない）。
export function serviceRoleConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createServiceRoleClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が設定されていません");
  }
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
