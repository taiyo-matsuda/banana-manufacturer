import "server-only";

import { notFound } from "next/navigation";
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import { cumulativeLeaves, cumulativeLeavesByCheck, leafCheckWarning } from "@/lib/leaves";
import { PHOTO_SIGNED_URL_TTL_SEC } from "@/lib/photos";
import {
  buildHistory,
  canRecordLeaves,
  type EventRow,
  type HistoryEntry,
  type ObservationRow,
  type PhotoRow,
  toLeafObservations,
  toLeavesRemoved,
} from "@/lib/stems/records";
import { latestDateJst } from "@/lib/stemEvents";
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
  latestObservedOn: string | null; // 直近の観測日（JST、YYYY-MM-DD）。出蕾の「前回訪問日」の既定値
  history: HistoryEntry[];
  // 1-9: Client Component が outbox の未送信分を重ねるための生データと、記録に必要な id
  userId: string; // observed_by / recorded_by / taken_by
  organizationId: string; // 写真の Storage パス
  observations: ObservationRow[];
  events: EventRow[];
  photos: PhotoRow[];
};

// 茎の記録入力（画面 4）と履歴（画面 8）で共通の読み込み。
// Suspense 境界の内側から呼ぶ（cookies() を読む）。他組織の茎は RLS で見えず notFound。
// PERF-1: ユーザー・茎・観測・イベント・写真は stemId だけで引けるので、1 回の Promise.all で並べて取る
// （Supabase への直列の往復は 1 回。写真があるときだけ署名付き URL でもう 1 回）。
// 組織 ID は茎の行の organization_id を使う（RLS の stems_all で見える茎は current_org() の行だけなので、
// profile の organization_id と同じ値。profile の select を省く）。
export async function loadStem(stemId: string): Promise<StemView> {
  const supabase = await createClient();

  // stems → mats は FK が 2 本（mat_id と origin_stem の逆参照）あるので、埋め込む関係を明示する
  const [
    currentUser,
    { data: stem, error: stemError },
    { data: observations, error: obsError },
    { data: events, error: evError },
    { data: photos, error: phError },
  ] = await Promise.all([
    getCurrentUser(),
    supabase
      .from("stems")
      .select("id, organization_id, generation, status, initial_leaf_count, mats!stems_mat_id_fkey ( id, code )")
      .eq("id", stemId)
      .maybeSingle(),
    supabase
      .from("observations")
      .select("id, type, value, observed_at, superseded_by, profiles ( display_name )")
      .eq("stem_id", stemId)
      .order("observed_at", { ascending: false }),
    supabase
      .from("events")
      .select("id, type, occurred_at, payload, superseded_by, profiles ( display_name )")
      .eq("target_type", "stem")
      .eq("target_id", stemId)
      .order("occurred_at", { ascending: false }),
    supabase
      .from("photos")
      .select("id, kind, taken_at, storage_path, profiles ( display_name )")
      .eq("target_type", "stem")
      .eq("target_id", stemId)
      .order("taken_at", { ascending: false }),
  ]);
  const user = userOrRedirect(currentUser);
  if (stemError) throw new Error(`茎を取得できませんでした（${stemError.message}）`);
  if (!stem) notFound();
  const mat = stem.mats as unknown as { id: string; code: string } | null;
  if (!mat) notFound();
  if (obsError) throw new Error(`観測を取得できませんでした（${obsError.message}）`);
  if (evError) throw new Error(`イベントを取得できませんでした（${evError.message}）`);
  if (phError) throw new Error(`写真を取得できませんでした（${phError.message}）`);

  // 非公開バケットなので署名付き URL をサーバーで作る（1 時間）。作れない写真は url=null（「画像なし」表示）
  const signedUrlByPath = new Map<string, string>();
  if (photos && photos.length > 0) {
    const { data: signed, error: signError } = await supabase.storage
      .from("photos")
      .createSignedUrls(
        photos.map((p) => p.storage_path),
        PHOTO_SIGNED_URL_TTL_SEC,
      );
    if (signError) console.error("createSignedUrls failed", { message: signError.message });
    for (const s of signed ?? []) {
      if (s.signedUrl && s.path) signedUrlByPath.set(s.path, s.signedUrl);
    }
  }

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
  const photoRows: PhotoRow[] = (photos ?? []).map((p) => ({
    id: p.id,
    kind: p.kind,
    taken_at: p.taken_at,
    url: signedUrlByPath.get(p.storage_path) ?? null,
    taker_name: nameOf(p.profiles),
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
    latestObservedOn: latestDateJst(observationRows.map((o) => o.observed_at)),
    history: buildHistory(observationRows, eventRows, photoRows),
    userId: user.id,
    organizationId: stem.organization_id,
    observations: observationRows,
    events: eventRows,
    photos: photoRows,
  };
}
