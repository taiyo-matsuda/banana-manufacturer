import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { ResetOnLeave } from "@/components/app/reset-on-leave";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isOriginTypeEditable } from "@/lib/mats/edit";
import { MAT_ORIGIN_LABELS, type MatOriginType } from "@/lib/mats/placement";
import { createClient } from "@/lib/supabase/server";
import { MatEditForm } from "./mat-edit-form";

// 株の編集（UX-2）: 株コード・品種・植え付け日・苗の種類。位置の修正（地図でドラッグ）はステップ 2。
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // RLS により他組織の株は見えない（0 件 → notFound）
  const [{ data: mat }, { data: cultivars }] = await Promise.all([
    supabase
      .from("mats")
      .select("id, code, cultivar_id, planted_at, origin_type, fields ( name )")
      .eq("id", matId)
      .maybeSingle(),
    supabase.from("cultivars").select("id, name").order("name"),
  ]);
  if (!mat) notFound();
  const field = mat.fields as unknown as { name: string } | null;

  return (
    <AppScreen
      title="株を編集"
      backHref={`/mats/${mat.id}`}
      backLabel={`株 ${mat.code}`}
      current="map"
    >
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
        </CardContent>
      </Card>
    </AppScreen>
  );
}
