// 計測用（PERF-1）: proxy の応答に付ける Server-Timing ヘッダの値。
// proxy の認証にかかった時間（ms、小数 1 桁）と、関数の実行リージョン（Vercel の VERCEL_REGION。ローカルは local）。
// 例: auth;dur=1.2;desc="hnd1"
export function authServerTiming(authMs: number, region: string | undefined): string {
  const desc = (region || "local").replace(/["\\]/g, "");
  const dur = Number.isFinite(authMs) && authMs > 0 ? Math.round(authMs * 10) / 10 : 0;
  return `auth;dur=${dur};desc="${desc}"`;
}
