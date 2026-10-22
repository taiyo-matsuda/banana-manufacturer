import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";
import { resolveAuthRedirect } from "@/lib/auth/redirect";

export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request);
  const target = resolveAuthRedirect(request.nextUrl.pathname, user !== null);
  if (target) {
    const url = request.nextUrl.clone();
    url.pathname = target;
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  // 静的ファイル・画像最適化・favicon・manifest・Service Worker（sw.js）などは対象外
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
