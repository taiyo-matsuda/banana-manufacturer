// E2E は手元の Supabase（`npx supabase start`）でだけ流す（タスク 0-3、architecture.md 7 章）。
// 本番（リモート、*.supabase.co）の無料枠を E2E で使わないため、URL が手元でなければ通信の前に止める。
// playwright.config.ts（開発サーバーを起動する前）と global-setup.ts（全テストの前）の両方から呼ぶ。

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLocalSupabaseUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// 同期のチェック: NEXT_PUBLIC_SUPABASE_URL のホストが 127.0.0.1 / localhost でなければ例外
export function assertLocalSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error(
      "E2E: NEXT_PUBLIC_SUPABASE_URL が設定されていません。.env.local を手元の Supabase の値にしてください（`npx supabase status` の API URL と Publishable key。.env.example を参照）",
    );
  }
  if (!isLocalSupabaseUrl(url)) {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // URL として読めなければそのまま出す
    }
    throw new Error(
      `E2E を止めました: NEXT_PUBLIC_SUPABASE_URL のホストが ${host} です。` +
        "E2E は手元の Supabase（http://127.0.0.1:54321）で流す。本番の無料枠を使わないため。" +
        "`.env.local` を手元の値（`npx supabase status`）に戻してください（本番の値は .env.remote.local と Vercel にある）",
    );
  }
  return url;
}

// 非同期のチェック: 手元の Supabase の API（Auth のヘルスチェック）に繋がるか
export async function assertLocalSupabaseRunning(): Promise<void> {
  const url = assertLocalSupabaseUrl();
  const health = new URL("/auth/v1/health", url).toString();
  const apikey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  let detail: string;
  try {
    const res = await fetch(health, { headers: { apikey }, signal: AbortSignal.timeout(5_000) });
    if (res.ok) return;
    detail = `HTTP ${res.status}`;
  } catch (e) {
    detail = (e as Error).message;
  }
  throw new Error(
    `E2E を止めました: 手元の Supabase（${health}）に繋がりません（${detail}）。` +
      "`npx supabase start` してください（Docker Desktop が必要）。初回やスキーマを変えた後は `npx supabase db reset` でマイグレーションとシードを流し直す",
  );
}

// service_role と CRON_SECRET: Cron の Route Handler（3-1）の E2E に必要。手元では `npx supabase status` で必ず取れる
export function assertServerSecrets(): void {
  const missing = ["SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "NEXT_PUBLIC_SUPABASE_ANON_KEY"].filter(
    (k) => !process.env[k],
  );
  if (missing.length > 0) {
    throw new Error(
      `E2E を止めました: .env.local に ${missing.join(" / ")} がありません。手元の値は \`npx supabase status\` で確認できる（.env.example を参照）`,
    );
  }
}
