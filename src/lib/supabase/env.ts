// Supabase の接続情報。Publishable key（公開用）だけを使う。service_role は絶対に置かない。
export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY が設定されていません（.env.local を確認）",
    );
  }
  return { url, key };
}
