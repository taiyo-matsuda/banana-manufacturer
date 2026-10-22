// 認証状態とパスから、リダイレクト先を決める純粋関数。proxy から使う。
// ログイン画面以外は認証が必要。ログイン済みでログイン画面を開いたらホームへ。

export const LOGIN_PATH = "/login";

export function resolveAuthRedirect(
  pathname: string,
  isAuthenticated: boolean,
): string | null {
  const isLoginPage = pathname === LOGIN_PATH;
  if (!isAuthenticated && !isLoginPage) return LOGIN_PATH;
  if (isAuthenticated && isLoginPage) return "/";
  return null;
}
