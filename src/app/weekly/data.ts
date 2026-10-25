import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { WeeklyStemRow } from "@/lib/weekly";

// 今週見る株（2-7）の行を 1 回の問い合わせで取る（view weekly_stems、0016。RLS は security_invoker で効く）。
// 撤去していない株の栽培中・出蕾済みの茎ごとに、最後の leaves_new の日時と合計（訂正済みを除く）が付く。観測は全件引かない。
// fieldId を渡すとその圃場に絞る（/weekly?field=）
export async function fetchWeeklyRows(fieldId?: string): Promise<{ rows: WeeklyStemRow[]; error: string | null }> {
  const supabase = await createClient();
  let query = supabase
    .from("weekly_stems")
    .select(
      "stem_id, mat_id, mat_code, mat_status, field_id, field_name, generation, status, started_at, bud_emerged_at, initial_leaf_count, last_leaves_new_at, leaves_new_sum",
    );
  if (fieldId) query = query.eq("field_id", fieldId);
  // PostgREST の既定の上限（max-rows）より多い場合に備えて明示する（栽培中の茎は株あたり最大 3 本）
  query = query.limit(5000);
  const { data, error } = await query;
  if (error) return { rows: [], error: error.message };
  const rows = (data ?? []).map((r) => ({ ...r, leaves_new_sum: Number(r.leaves_new_sum ?? 0) })) as WeeklyStemRow[];
  return { rows, error: null };
}
