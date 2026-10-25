import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseEnv } from "./env";

// proxy（旧 middleware）用。セッションの Cookie を更新しつつ、ログインしているかを返す。
//
// PERF-1: getUser()（毎回 Auth サーバーへの往復）ではなく getClaims() を使う。
// @supabase/auth-js 2.118 の getClaims() の実装（GoTrueClient.getClaims）を確認した内容:
// - トークンは getSession() から取る。getSession() はアクセストークンの期限が EXPIRY_MARGIN_MS（90 秒）以内なら
//   refresh token でセッションを更新し、_saveSession → TOKEN_REFRESHED を通知する。@supabase/ssr の
//   createServerClient はその通知で applyServerStorage → 下の setAll を呼ぶので、getUser() のときと同じく
//   更新後の Cookie が request と response の両方に載る（getUser() も同じ getSession 系の経路で refresh する）。
//   refresh に失敗してセッションがなければ claims は null（＝未ログイン扱い）。
// - exp を validateExp で検証する（exp が無い・過ぎていればエラー → claims は null）。
// - 署名: JWT の header.alg が非対称（この Supabase は ES256）で kid があり、WebCrypto があれば、
//   /auth/v1/.well-known/jwks.json の公開鍵で crypto.subtle.verify する（不一致ならエラー → claims は null）。
//   JWKS はモジュール内の GLOBAL_JWKS に 10 分（JWKS_TTL）キャッシュされるので、通常はネットワークに出ない。
//   alg が HS 系・kid なし・WebCrypto なしのときは getUser(token) にフォールバックしてサーバーで検証する。
// 画面・Server Action では lib/auth/current-user.ts の getCurrentUser()（getUser、1 リクエスト 1 回）で改めて確かめる。
export async function updateSession(request: NextRequest) {
  const { url, key } = supabaseEnv();
  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const startedAt = performance.now();
  const { data } = await supabase.auth.getClaims();
  const authMs = performance.now() - startedAt;

  return { response, isAuthenticated: Boolean(data?.claims?.sub), authMs };
}
