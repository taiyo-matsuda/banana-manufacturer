// 認証状態とパスから、リダイレクト先を決める純粋関数。proxy から使う。
// ログイン画面以外は認証が必要。ログイン済みでログイン画面を開いたらホームへ。

export const LOGIN_PATH = "/login";

// 認証なしで開けるパス。/offline は Service Worker が圏外時に返す案内ページ（1-10）、/offline-shell はオフラインの殻（2-9）で、
// どちらも install 時に（認証に関係なく）プリキャッシュできる必要がある。殻はサーバーでデータを読まない（端末のキャッシュだけ）。
export const PUBLIC_PATHS: readonly string[] = ["/offline", "/offline-shell"];

export function resolveAuthRedirect(
  pathname: string,
  isAuthenticated: boolean,
): string | null {
  const isLoginPage = pathname === LOGIN_PATH;
  if (PUBLIC_PATHS.includes(pathname)) return null;
  if (!isAuthenticated && !isLoginPage) return LOGIN_PATH;
  if (isAuthenticated && isLoginPage) return "/";
  return null;
}
