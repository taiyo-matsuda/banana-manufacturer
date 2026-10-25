import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MapIcon, PencilIcon } from "lucide-react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { DeviceOwner } from "@/components/app/device-store";
import { RememberMat } from "@/components/app/remember-mat";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FIRST_STEM_PLANTED_AT_DIFFERS_MESSAGE, firstStemPlantedAtDiffers } from "@/lib/mats/edit";
import { MAT_ORIGIN_LABELS, type MatOriginType } from "@/lib/mats/placement";
import { canAddActiveStem, nextGeneration } from "@/lib/stems/registration";
import type { MatStemRow } from "@/lib/offline/overlay";
import { sortStemsByGeneration } from "@/lib/stems/status";
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";
import { MatStems } from "./mat-stems";
import { StemForm } from "./stem-form";

// 画面 3「株の詳細」: コード、品種、植え付け日、苗の種類、由来、茎の一覧（世代順。状態と累計葉数）、茎の登録。
// 各茎は茎の記録入力（/stems/[stemId]、1-6）へリンクする。吸芽の発生（2-1）は「吸芽が出た」で記録する（mat-stems.tsx / sucker-record.tsx）。予測収穫日（ステップ 3）、吸芽の採用/株分け（2-2）は後のタスクで追加する。
// 株の編集（/mats/[matId]/edit、UX-2）への導線。株の植え付け日と最初の茎の植え付け日がずれていたら注意を出す（データは直さない）。
// 開いた株は端末に残し、ホームの「最近開いた株」から 1 タップで戻れる（UX-1）。
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

const ORIGIN_LABELS: Record<string, string> = {
  ...MAT_ORIGIN_LABELS,
  sucker_transplant: "株分け",
};

function originLabel(originType: string): string {
  return ORIGIN_LABELS[originType as MatOriginType] ?? originType;
}

async function MatDetail({ params }: { params: Promise<{ matId: string }> }) {
  const { matId } = await params;
  const supabase = await createClient();

  // PERF-1: ユーザー・株・茎（葉の観測を埋め込み）は matId だけで引けるので、1 回の Promise.all で並べて取る
  // （Supabase への直列の往復は 1 回）。
  // - 株: RLS により他組織の株は見えない（0 件 → notFound）。由来（株分けの元の茎が属する株）は
  //   mats.origin_stem_id の FK（mats_origin_stem_fk）で埋め込む（1-4 時点では origin_stem_id は null のみ）
  // - 茎: 累計葉数 = 初期葉数 + Σ leaves_new（現在の値 = superseded_by が null の観測だけ）。
  //   埋め込んだ observations を type / superseded_by で絞る（茎の行は絞らない）
  const [currentUser, { data: mat }, { data: stemRows, error: stemsError }] = await Promise.all([
    getCurrentUser(),
    supabase
      .from("mats")
      .select(
        "id, code, planted_at, origin_type, origin_stem_id, status, fields ( id, name, code ), cultivars ( name ), origin_stem:stems!mats_origin_stem_fk ( mat:mats!stems_mat_id_fkey ( id, code ) )",
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
  ]);
  const user = userOrRedirect(currentUser);
  if (!mat) notFound();

  const field = mat.fields as unknown as { id: string; name: string; code: string } | null;
  const cultivar = mat.cultivars as unknown as { name: string } | null;
  const originMat = mat.origin_stem_id
    ? ((mat.origin_stem as unknown as { mat: { id: string; code: string } | null } | null)?.mat ?? null)
    : null;

  const sortedStems = sortStemsByGeneration(stemRows ?? []);

  // 2-1: 茎一覧は Client Component（mat-stems.tsx）が端末の未送信分（吸芽・観測）を重ねて描く。
  // 観測は全種類の現在の値（累計葉数は leaves_new だけを数える。前回訪問日の既定値は全種類の直近の観測日）
  const matStems: MatStemRow[] = sortedStems.map((s) => ({
    id: s.id,
    generation: s.generation,
    status: s.status,
    started_at: s.started_at,
    initial_leaf_count: s.initial_leaf_count ?? 0,
    parent_stem_id: s.parent_stem_id,
    observations: (s.observations ?? []).map((o) => ({ id: o.id, type: o.type, value: Number(o.value), observed_at: o.observed_at })),
  }));

  // 茎の登録: 栽培中（active / flowered）が 3 本ならフォームを出さず理由を表示（DB の正本はトリガー）
  const addCheck = canAddActiveStem(sortedStems);
  const plantedAtDiffers = firstStemPlantedAtDiffers(mat.planted_at, sortedStems);
  const next = nextGeneration(sortedStems);

  return (
    <AppScreen title="株の詳細" backHref={field ? `/fields/${field.id}/map` : "/map"} backLabel="地図" current="map">
      <DeviceOwner userId={user.id} />
      <RememberMat id={mat.id} code={mat.code} field={field ? { id: field.id, name: field.name } : null} />

      <Card>
        <CardHeader>
          <p className="text-sm text-muted-foreground">株</p>
          <CardTitle className="font-mono text-2xl" data-testid="mat-code">
            {mat.code}
          </CardTitle>
          <CardAction>
            <Button asChild variant="outline">
              <Link href={`/mats/${mat.id}/edit`} data-testid="mat-edit-link">
                <PencilIcon aria-hidden="true" />
                編集
              </Link>
            </Button>
          </CardAction>
          {mat.status === "removed" && (
            <p className="text-muted-foreground" data-testid="mat-status">
              この株は除去済みです
            </p>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">品種</dt>
            <dd data-testid="mat-cultivar">{cultivar?.name ?? "（不明）"}</dd>
            <dt className="text-muted-foreground">植え付け日</dt>
            <dd data-testid="mat-planted-at">{mat.planted_at}</dd>
            <dt className="text-muted-foreground">苗の種類</dt>
            <dd data-testid="mat-origin-type">{originLabel(mat.origin_type)}</dd>
            <dt className="text-muted-foreground">由来</dt>
            <dd data-testid="mat-origin">
              {originMat ? (
                <Link href={`/mats/${originMat.id}`} className="text-primary underline underline-offset-4">
                  株 {originMat.code} から株分け
                </Link>
              ) : (
                "この位置に植え付け"
              )}
            </dd>
          </dl>
          {plantedAtDiffers && (
            <Alert variant="warning" data-testid="mat-planted-at-differs">
              <AlertDescription>{FIRST_STEM_PLANTED_AT_DIFFERS_MESSAGE}</AlertDescription>
            </Alert>
          )}
          {field && (
            <Button asChild variant="outline">
              <Link href={`/fields/${field.id}/map`} data-testid="mat-map-link">
                <MapIcon aria-hidden="true" />
                <span className="truncate">地図へ（{field.name}）</span>
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>茎</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {stemsError ? (
            <p role="alert" className="text-destructive">
              茎を取得できませんでした（{stemsError.message}）
            </p>
          ) : (
            <MatStems stems={matStems} canRecordSucker={mat.status !== "removed"} />
          )}

          {mat.status !== "removed" &&
            (addCheck.ok ? (
              <StemForm matId={mat.id} defaultPlantedAt={mat.planted_at} nextGeneration={next.generation} />
            ) : (
              <p className="text-muted-foreground" data-testid="stem-add-blocked">
                {addCheck.reason}
              </p>
            ))}
        </CardContent>
      </Card>
    </AppScreen>
  );
}
