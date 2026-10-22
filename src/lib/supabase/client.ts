"use client";

import { createBrowserClient } from "@supabase/ssr";
import { supabaseEnv } from "./env";

// ブラウザ用クライアント。セッションは Cookie に保存され、サーバー側と共有される。
export function createClient() {
  const { url, key } = supabaseEnv();
  return createBrowserClient(url, key);
}
