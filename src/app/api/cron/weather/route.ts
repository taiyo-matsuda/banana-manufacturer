import { createServiceRoleClient, serviceRoleConfigured } from "@/lib/supabase/service-role";
import { MOCK_FAULT_NAME, mockFaultFrom, weatherFetcher } from "@/lib/weather/server";
import { SYNC_FIELD_COLUMNS, syncFieldWeather, type SyncField, type SyncResult } from "@/lib/weather/sync";

// 気温の日次取り込み（3-1、architecture.md 5 章）。Vercel Cron（vercel.json、1 日 1 回 日本時間の早朝）と
// 手動実行（npm run weather:sync）が GET で叩く。
//
// 認証: Authorization: Bearer ${CRON_SECRET}（Vercel Cron の標準）。CRON_SECRET が未設定・ヘッダが無い・違うなら 401。
// 全組織の圃場を処理するので、ここだけ service_role のクライアントを使う（architecture.md 2・7 章の例外。
// キーは src/lib/supabase/service-role.ts（server-only）に閉じ込めている）。
// ?fieldId=<uuid> を付けるとその圃場だけ（E2E はテスト用の圃場だけを処理する。本番データと同居しているため）。
//
// 1 回の実行は約 50 秒で打ち切る（Vercel の関数の時間制限）。過去 API の残り（10 年分の平年値の材料など）は次回に続きから取る。
// 前回の実行が古い圃場から順に処理する。
export const maxDuration = 60;
const BUDGET_MS = 50_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!serviceRoleConfigured()) {
    return Response.json({ error: "SUPABASE_SERVICE_ROLE_KEY が設定されていません" }, { status: 500 });
  }

  const startedAt = Date.now();
  const url = new URL(request.url);
  const fieldId = url.searchParams.get("fieldId");
  if (fieldId !== null && !UUID_PATTERN.test(fieldId)) {
    return Response.json({ error: "fieldId が不正です" }, { status: 400 });
  }

  const db = createServiceRoleClient();
  let query = db.from("fields").select(SYNC_FIELD_COLUMNS);
  if (fieldId) query = query.eq("id", fieldId);
  const [{ data: fields, error }, { data: statuses }] = await Promise.all([
    query,
    db.from("weather_sync_status").select("field_id, last_run_at"),
  ]);
  if (error) {
    console.error("weather cron: fields select failed", error.message);
    return Response.json({ error: "圃場を読めません" }, { status: 500 });
  }
  if (fieldId && (fields ?? []).length === 0) {
    return Response.json({ error: "圃場が見つかりません" }, { status: 404 });
  }

  // 前回の実行が古い順（未実行が先）
  const lastRun = new Map((statuses ?? []).map((s) => [s.field_id as string, s.last_run_at as string]));
  const ordered = [...((fields ?? []) as SyncField[])].sort((a, b) =>
    (lastRun.get(a.id) ?? "").localeCompare(lastRun.get(b.id) ?? ""),
  );

  const fetchFn = weatherFetcher(mockFaultFrom(request.headers.get(MOCK_FAULT_NAME)));
  const deadline = startedAt + BUDGET_MS;
  const results: SyncResult[] = [];
  let skipped = 0;
  for (const field of ordered) {
    if (Date.now() > deadline) {
      skipped++;
      continue;
    }
    const r = await syncFieldWeather(db, fetchFn, field, { includeNormals: true, deadline });
    if (r.errors.length > 0) console.error("weather cron: field sync errors", field.id, r.errors);
    results.push(r);
  }

  return Response.json({
    ok: results.every((r) => r.errors.length === 0),
    processed: results.length,
    skipped,
    results,
    ms: Date.now() - startedAt,
  });
}
