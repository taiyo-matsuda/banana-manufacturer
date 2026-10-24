import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { MapIcon } from "lucide-react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { LinkList, LinkListItem, LinkRow } from "@/components/app/link-list";
import { DeviceOwner } from "@/components/app/device-store";
import { RememberMat } from "@/components/app/remember-mat";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cumulativeLeaves, type LeafObservation } from "@/lib/leaves";
import { MAT_ORIGIN_LABELS, type MatOriginType } from "@/lib/mats/placement";
import { canAddActiveStem, nextGeneration } from "@/lib/stems/registration";
import { generationLabel, sortStemsByGeneration, stemStatusLabel } from "@/lib/stems/status";
import { createClient } from "@/lib/supabase/server";
import { StemForm } from "./stem-form";

// 画面 3「株の詳細」: コード、品種、植え付け日、苗の種類、由来、茎の一覧（世代順。状態と累計葉数）、茎の登録。
// 各茎は茎の記録入力（/stems/[stemId]、1-6）へリンクする。予測収穫日（ステップ 3）、吸芽の採用/株分け（ステップ 2）は後のタスクで追加する。
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS により他組織の株は見えない（0 件 → notFound）
  const { data: mat } = await supabase
    .from("mats")
    .select(
      "id, code, planted_at, origin_type, origin_stem_id, status, fields ( id, name, code ), cultivars ( name )",
    )
    .eq("id", matId)
    .maybeSingle();
  if (!mat) notFound();

  const field = mat.fields as unknown as { id: string; name: string; code: string } | null;
  const cultivar = mat.cultivars as unknown as { name: string } | null;

  const [{ data: stems, error: stemsError }, originMat] = await Promise.all([
    supabase
      .from("stems")
      .select("id, generation, status, started_at, initial_leaf_count")
      .eq("mat_id", mat.id)
      .order("generation")
      .order("started_at"),
    // 由来: 株分けなら元の茎が属する株へのリンク（1-4 時点では origin_stem_id は null のみ）
    mat.origin_stem_id
      ? supabase
          .from("stems")
          .select("mat_id, mats ( id, code )")
          .eq("id", mat.origin_stem_id)
          .maybeSingle()
          .then((r) => (r.data?.mats as unknown as { id: string; code: string } | null) ?? null)
      : Promise.resolve(null),
  ]);

  const sortedStems = sortStemsByGeneration(stems ?? []);

  // 累計葉数 = 初期葉数 + Σ leaves_new（現在の値 = superseded_by が null の観測だけ）
  const leavesByStem = new Map<string, LeafObservation[]>();
  if (sortedStems.length > 0) {
    const { data: observations } = await supabase
      .from("observations")
      .select("stem_id, type, value, observed_at")
      .in(
        "stem_id",
        sortedStems.map((s) => s.id),
      )
      .eq("type", "leaves_new")
      .is("superseded_by", null);
    for (const o of observations ?? []) {
      const list = leavesByStem.get(o.stem_id) ?? [];
      list.push({ type: "leaves_new", value: Number(o.value), observedAt: new Date(o.observed_at) });
      leavesByStem.set(o.stem_id, list);
    }
  }

  // 茎の登録: 栽培中（active / flowered）が 3 本ならフォームを出さず理由を表示（DB の正本はトリガー）
  const addCheck = canAddActiveStem(sortedStems);
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
          ) : sortedStems.length === 0 ? (
            <p className="text-muted-foreground" data-testid="stems-empty">
              茎なし
            </p>
          ) : (
            <LinkList data-testid="stem-list">
              {sortedStems.map((s) => (
                <LinkListItem
                  key={s.id}
                  data-testid="stem-item"
                  data-stem-id={s.id}
                  data-generation={s.generation}
                  data-status={s.status}
                >
                  <LinkRow
                    href={`/stems/${s.id}`}
                    data-testid="stem-link"
                    aria-label={`${generationLabel(s.generation)}の記録入力`}
                  >
                    <span>
                      <span className="font-medium">{generationLabel(s.generation)}</span>
                      <span className="ml-2 text-sm text-muted-foreground">第 {s.generation} 世代</span>
                    </span>
                    <span className="flex flex-col items-end text-sm text-muted-foreground">
                      <span data-testid="stem-status">{stemStatusLabel(s.status)}</span>
                      <span>
                        累計葉数{" "}
                        <span className="text-base font-semibold text-foreground" data-testid="stem-cumulative-leaves">
                          {cumulativeLeaves(s.initial_leaf_count, leavesByStem.get(s.id) ?? [])}
                        </span>{" "}
                        枚
                      </span>
                    </span>
                  </LinkRow>
                </LinkListItem>
              ))}
            </LinkList>
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
