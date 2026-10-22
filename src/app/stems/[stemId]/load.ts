import "server-only";

import { notFound, redirect } from "next/navigation";
import { cumulativeLeaves, cumulativeLeavesByCheck, leafCheckWarning } from "@/lib/leaves";
import {
  buildHistory,
  canRecordLeaves,
  type EventRow,
  type HistoryEntry,
  type ObservationRow,
  toLeafObservations,
  toLeavesRemoved,
} from "@/lib/stems/records";
import { createClient } from "@/lib/supabase/server";

export type StemView = {
  id: string;
  generation: number;
  status: string;
  initialLeafCount: number;
  mat: { id: string; code: string };
  cumulative: number;
  byCheck: number | null;
  checkWarning: string | null;
  canRecord: boolean;
  history: HistoryEntry[];
};

// 茎の記録入力（画面 4）と履歴（画面 8）で共通の読み込み。
// Suspense 境界の内側から呼ぶ（cookies() を読む）。他組織の茎は RLS で見えず notFound。
export async function loadStem(stemId: string): Promise<StemView> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // stems → mats は FK が 2 本（mat_id と origin_stem の逆参照）あるので、埋め込む関係を明示する
  const { data: stem, error: stemError } = await supabase
    .from("stems")
    .select("id, generation, status, initial_leaf_count, mats!stems_mat_id_fkey ( id, code )")
    .eq("id", stemId)
    .maybeSingle();
  if (stemError) throw new Error(`茎を取得できませんでした（${stemError.message}）`);
  if (!stem) notFound();
  const mat = stem.mats as unknown as { id: string; code: string } | null;
  if (!mat) notFound();

  const [{ data: observations, error: obsError }, { data: events, error: evError }] = await Promise.all([
    supabase
      .from("observations")
      .select("id, type, value, observed_at, superseded_by, profiles ( display_name )")
      .eq("stem_id", stem.id)
      .order("observed_at", { ascending: false }),
    supabase
      .from("events")
      .select("id, type, occurred_at, payload, superseded_by, profiles ( display_name )")
      .eq("target_type", "stem")
      .eq("target_id", stem.id)
      .order("occurred_at", { ascending: false }),
  ]);
  if (obsError) throw new Error(`観測を取得できませんでした（${obsError.message}）`);
  if (evError) throw new Error(`イベントを取得できませんでした（${evError.message}）`);

  const nameOf = (p: unknown) => (p as { display_name: string | null } | null)?.display_name ?? null;
  const observationRows: ObservationRow[] = (observations ?? []).map((o) => ({
    id: o.id,
    type: o.type,
    value: Number(o.value),
    observed_at: o.observed_at,
    superseded_by: o.superseded_by,
    observer_name: nameOf(o.profiles),
  }));
  const eventRows: EventRow[] = (events ?? []).map((e) => ({
    id: e.id,
    type: e.type,
    occurred_at: e.occurred_at,
    payload: (e.payload as Record<string, unknown> | null) ?? null,
    superseded_by: e.superseded_by,
    recorder_name: nameOf(e.profiles),
  }));

  const leafObs = toLeafObservations(observationRows);
  const initialLeafCount = stem.initial_leaf_count ?? 0;
  const cumulative = cumulativeLeaves(initialLeafCount, leafObs);
  const byCheck = cumulativeLeavesByCheck(leafObs, toLeavesRemoved(eventRows));

  return {
    id: stem.id,
    generation: stem.generation,
    status: stem.status,
    initialLeafCount,
    mat,
    cumulative,
    byCheck,
    checkWarning: leafCheckWarning(cumulative, byCheck),
    canRecord: canRecordLeaves(stem.status),
    history: buildHistory(observationRows, eventRows),
  };
}
