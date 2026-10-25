import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";
import { authServerTiming } from "@/lib/auth/server-timing";
import { resolveAuthRedirect } from "@/lib/auth/redirect";

export async function proxy(request: NextRequest) {
  const { response, isAuthenticated, authMs } = await updateSession(request);
  // 計測用（PERF-1）。ヘッダを付けるだけで挙動は変えない（リダイレクトにも付ける）
  const timing = authServerTiming(authMs, process.env.VERCEL_REGION);
  const target = resolveAuthRedirect(request.nextUrl.pathname, isAuthenticated);
  if (target) {
    const url = request.nextUrl.clone();
    url.pathname = target;
    url.search = "";
    const redirect = NextResponse.redirect(url);
    redirect.headers.append("Server-Timing", timing);
    return redirect;
  }
  response.headers.append("Server-Timing", timing);
  return response;
}

export const config = {
  // 静的ファイル・画像最適化・favicon・manifest・Service Worker（sw.js）などは対象外
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
