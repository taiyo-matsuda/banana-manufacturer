import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { ResetOnLeave } from "@/components/app/reset-on-leave";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { isOriginTypeEditable } from "@/lib/mats/edit";
import { canRemoveMat } from "@/lib/mats/remove";
import { MAT_ORIGIN_LABELS, type MatOriginType } from "@/lib/mats/placement";
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";
import { MatEditForm } from "./mat-edit-form";
import { RemoveMat } from "./remove-mat";

// 株の編集（UX-2）: 株コード・品種・植え付け日・苗の種類。位置の修正は地図の「位置を直す」（2-3）。
// 下に「株を撤去する」（2-3。危険な操作として控えめに。栽培中の茎・未処理の吸芽があれば理由を出して無効）。
// 撤去済みの株は編集できない（理由を出して株の詳細へ戻す導線だけ）。
// 保存すると株の詳細へ戻る。キャンセル・ヘッダの「戻る」も株の詳細へ。
// params は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
// 戻る先（株コード）は株を読んでから決まるので、画面全体を Suspense の中で描く。
export default function EditMatPage({
  params,
}: {
  params: Promise<{ matId: string }>;
}) {
  return (
    <Suspense
      fallback={
        <AppScreen title="株を編集" current="map">
          <LoadingText />
        </AppScreen>
      }
    >
      <EditMat params={params} />
    </Suspense>
  );
}

const ORIGIN_LABELS: Record<string, string> = {
  ...MAT_ORIGIN_LABELS,
  sucker_transplant: "株分け",
};

async function EditMat({ params }: { params: Promise<{ matId: string }> }) {
  const { matId } = await params;
  const supabase = await createClient();
  // RLS により他組織の株は見えない（0 件 → notFound）
  // PERF-1: ユーザーの確認も株・品種の select と並べる（直列の往復 2 → 1）
  const [currentUser, { data: mat }, { data: cultivars }, { data: stems, error: stemsError }] = await Promise.all([
    getCurrentUser(),
    supabase
      .from("mats")
      .select("id, code, cultivar_id, planted_at, origin_type, status, fields ( name )")
      .eq("id", matId)
      .maybeSingle(),
    supabase.from("cultivars").select("id, name").order("name"),
    // 撤去できるかの事前判定（栽培中の茎・未処理の吸芽）に使う。正本は RPC remove_mat
    supabase.from("stems").select("status").eq("mat_id", matId),
  ]);
  userOrRedirect(currentUser);
  if (!mat) notFound();
  const field = mat.fields as unknown as { name: string } | null;

  return (
    <AppScreen
      title="株を編集"
      backHref={`/mats/${mat.id}`}
      backLabel={`株 ${mat.code}`}
      current="map"
    >
      {mat.status === "removed" ? (
        <Alert data-testid="mat-edit-removed">
          <AlertDescription className="flex flex-col gap-3">
            <span>株 {mat.code} は撤去済みのため編集できません</span>
            <Button asChild variant="outline">
              <Link href={`/mats/${mat.id}`}>株の詳細へ</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="font-mono">{mat.code}</CardTitle>
            {field && <CardDescription>{field.name}</CardDescription>}
          </CardHeader>
          <CardContent>
            {/* 開くたびに DB の値から始める（キャンセルした入力・前回のエラーを残さない） */}
            <ResetOnLeave
              resetKey={JSON.stringify([
                mat.code,
                mat.cultivar_id,
                mat.planted_at,
                mat.origin_type,
              ])}
            >
              <MatEditForm
                matId={mat.id}
                initial={{
                  code: mat.code,
                  cultivarId: mat.cultivar_id,
                  plantedAt: mat.planted_at,
                  originType: isOriginTypeEditable(mat.origin_type)
                    ? mat.origin_type
                    : "",
                }}
                originEditable={isOriginTypeEditable(mat.origin_type)}
                originLabel={
                  ORIGIN_LABELS[mat.origin_type as MatOriginType] ??
                  mat.origin_type
                }
                cultivars={cultivars ?? []}
              />
            </ResetOnLeave>
            <div className="mt-8">
              <RemoveMat
                matId={mat.id}
                code={mat.code}
                check={
                  stemsError
                    ? { ok: false, reason: "茎を取得できなかったため撤去できません。画面を再読み込みしてください" }
                    : canRemoveMat(mat, stems ?? [])
                }
              />
            </div>
          </CardContent>
        </Card>
      )}
    </AppScreen>
  );
}
