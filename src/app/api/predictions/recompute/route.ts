import { getCurrentUser } from "@/lib/auth/current-user";
import { recomputeDerived } from "@/lib/derived";
import { createClient } from "@/lib/supabase/server";

// 収穫予測日の再計算（3-3、prediction.md 2 章）。茎の出蕾・被害は端末の outbox から同期ワーカーが RPC で送るので
// （オンラインでも同じ経路。offline-sync.md 1 章）、送れた直後に同期ワーカー（src/lib/offline/sender.ts）がここを呼ぶ。
// ログイン中のユーザーのクライアント（RLS で自組織の茎だけ）で予測し、estimates に追記する（前回と同じなら追記しない）。
// 他組織・存在しない・出蕾前の茎は何もしない（stems: 0）。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON ではありません" }, { status: 400 });
  }
  const stemId = (body as { stemId?: unknown } | null)?.stemId;
  if (typeof stemId !== "string" || !UUID_PATTERN.test(stemId)) {
    return Response.json({ error: "stemId が不正です" }, { status: 400 });
  }

  const supabase = await createClient();
  const result = await recomputeDerived(supabase, { stemIds: [stemId] });
  if (result.errors.length > 0 || result.recommendations.errors.length > 0) {
    console.error("recompute (stem event) errors", stemId, result.errors, result.recommendations.errors);
    return Response.json({ ok: false, ...result }, { status: 500 });
  }
  return Response.json({ ok: true, ...result });
}
