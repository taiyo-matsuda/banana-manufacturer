import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { MAT_HISTORY_LIMIT, type MatDetailData } from "@/lib/mats/detail";
import type { MatStemRow } from "@/lib/offline/overlay";
import { sortStemsByGeneration } from "@/lib/stems/status";
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";
import { MatDetailScreen } from "./mat-detail-view";

// 画面 3「株の詳細」: コード、品種、植え付け日、苗の種類、由来、茎の一覧（世代順。状態と累計葉数）、茎の登録。
// 各茎は茎の記録入力（/stems/[stemId]、1-6）へリンクする。吸芽の発生（2-1）は「吸芽が出た」で記録する（mat-stems.tsx / sucker-record.tsx）。吸芽の採用・芽かき・株分け（2-2）は吸芽の行のボタン（sucker-actions.tsx）。株分けで作った株は由来（元の株と茎の世代）へリンクする。予測収穫日（ステップ 3）は後のタスクで追加する。
// 株の編集（/mats/[matId]/edit、UX-2）への導線。株の植え付け日と最初の茎の植え付け日がずれていたら注意を出す（データは直さない）。
// 開いた株は端末に残し、ホームの「最近開いた株」から 1 タップで戻れる（UX-1）。
// 株単位のイベント（target_type=mat。施肥 2-4、株の被害 2-5、撤去など）は「株の記録」に新しい順で出す（茎の履歴と同じ表示）。
// 株の被害（2-5）は「株の記録」の「被害を記録」（撤去済みの株には出さない）。
// 撤去した株（2-3、要確認 11）も URL で開ける。上部に「撤去済み（日付・理由）」を出し、記録・編集・吸芽のボタンを出さない。
// 撤去済みの株は「最近開いた株」に残さない（残っていれば外す）。
// 表示は mat-detail-view.tsx（オフラインの殻 2-9 と共通）。ここはサーバーでのデータの取得だけ。
// params は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
// 戻る先（この株の圃場の地図）は株を読んでから決まるので、画面全体を Suspense の中で描く。
export default function MatDetailPage({ params }: { params: Promise<{ matId: string }> }) {
  return (
    <Suspense
      fallback={
        <AppScreen title="株の詳細" current="map">
          <LoadingText />
        </AppScreen>
      }
    >
      <MatDetail params={params} />
    </Suspense>
  );
}

async function MatDetail({ params }: { params: Promise<{ matId: string }> }) {
  const { matId } = await params;
  const supabase = await createClient();

  // PERF-1: ユーザー・株・茎（葉の観測を埋め込み）は matId だけで引けるので、1 回の Promise.all で並べて取る
  // （Supabase への直列の往復は 1 回）。
  // - 株: RLS により他組織の株は見えない（0 件 → notFound）。由来（株分けの元の茎が属する株）は
  //   mats.origin_stem_id の FK（mats_origin_stem_fk）で埋め込む（株分け 2-2 で作った株だけが持つ）
  // - 茎: 累計葉数 = 初期葉数 + Σ leaves_new（現在の値 = superseded_by が null の観測だけ）。
  //   埋め込んだ observations を type / superseded_by で絞る（茎の行は絞らない）
  const [
    currentUser,
    { data: mat },
    { data: stemRows, error: stemsError },
    { data: removedEvents },
    { data: matEvents, error: matEventsError },
  ] = await Promise.all([
    getCurrentUser(),
    supabase
      .from("mats")
      .select(
        "id, code, planted_at, origin_type, origin_stem_id, status, fields ( id, name, code ), cultivars ( name ), origin_stem:stems!mats_origin_stem_fk ( generation, mat:mats!stems_mat_id_fkey ( id, code ) )",
      )
      .eq("id", matId)
      .maybeSingle(),
    supabase
      .from("stems")
      .select("id, generation, status, started_at, initial_leaf_count, parent_stem_id, observations ( id, type, value, observed_at )")
      .eq("mat_id", matId)
      .is("observations.superseded_by", null)
      .order("generation")
      .order("started_at"),
    // 撤去の記録（撤去済みのときだけ使う。日付と理由を上部に出す）。撤去していない株では 0 件
    supabase
      .from("events")
      .select("occurred_at, payload")
      .eq("target_type", "mat")
      .eq("target_id", matId)
      .eq("type", "mat_removed")
      .is("superseded_by", null)
      .order("occurred_at", { ascending: false })
      .limit(1),
    // 株単位のイベントの履歴（新しい順。訂正済みも打ち消し表示で出す）
    supabase
      .from("events")
      .select("id, type, occurred_at, payload, note, superseded_by, profiles ( display_name )")
      .eq("target_type", "mat")
      .eq("target_id", matId)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(MAT_HISTORY_LIMIT),
  ]);
  const user = userOrRedirect(currentUser);
  if (!mat) notFound();

  const field = mat.fields as unknown as { id: string; name: string; code: string } | null;
  const cultivar = mat.cultivars as unknown as { name: string } | null;
  const originStem = mat.origin_stem_id
    ? (mat.origin_stem as unknown as { generation: number; mat: { id: string; code: string } | null } | null)
    : null;

  // 2-1: 茎一覧は Client Component（mat-stems.tsx）が端末の未送信分（吸芽・観測）を重ねて描く。
  // 観測は全種類の現在の値（累計葉数は leaves_new だけを数える。前回訪問日の既定値は全種類の直近の観測日）
  const stems: MatStemRow[] = sortStemsByGeneration(stemRows ?? []).map((s) => ({
    id: s.id,
    generation: s.generation,
    status: s.status,
    started_at: s.started_at,
    initial_leaf_count: s.initial_leaf_count ?? 0,
    parent_stem_id: s.parent_stem_id,
    observations: (s.observations ?? []).map((o) => ({ id: o.id, type: o.type, value: Number(o.value), observed_at: o.observed_at })),
  }));

  const data: MatDetailData = {
    mat: { id: mat.id, code: mat.code, planted_at: mat.planted_at, origin_type: mat.origin_type, status: mat.status },
    field,
    cultivarName: cultivar?.name ?? null,
    origin: originStem?.mat ? { matId: originStem.mat.id, matCode: originStem.mat.code, generation: originStem.generation } : null,
    stems,
    stemsError: stemsError?.message ?? null,
    removedEvent: removedEvents?.[0] ?? null,
    history: (matEvents ?? []).map((e) => ({
      id: e.id,
      type: e.type,
      occurred_at: e.occurred_at,
      payload: (e.payload as Record<string, unknown> | null) ?? null,
      superseded_by: e.superseded_by,
      note: e.note,
      recorder_name: (e.profiles as unknown as { display_name: string | null } | null)?.display_name ?? null,
    })),
    historyError: matEventsError?.message ?? null,
  };

  return <MatDetailScreen data={data} userId={user.id} />;
}
