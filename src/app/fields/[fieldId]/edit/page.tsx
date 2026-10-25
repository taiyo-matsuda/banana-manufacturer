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
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";
import { FieldForm } from "../../field-form";

// 圃場の編集（UX-2）: 名前・圃場記号・代表点（緯度経度）・メモ。登録（/fields/new）と同じフォーム部品・同じ検証。
// 保存すると圃場の詳細へ戻る。キャンセル・ヘッダの「戻る」も圃場の詳細へ。
// params は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
// 戻る先は fieldId から決まるので、画面全体を Suspense の中で描く。
export default function EditFieldPage({
  params,
}: {
  params: Promise<{ fieldId: string }>;
}) {
  return (
    <Suspense
      fallback={
        <AppScreen title="圃場を編集" current="settings">
          <LoadingText />
        </AppScreen>
      }
    >
      <EditField params={params} />
    </Suspense>
  );
}

async function EditField({ params }: { params: Promise<{ fieldId: string }> }) {
  const { fieldId } = await params;
  const supabase = await createClient();
  // RLS により他組織の圃場は見えない（0 件 → notFound）
  // PERF-1: ユーザーの確認と圃場の select を並べる（直列の往復 2 → 1）
  const [currentUser, { data: field }] = await Promise.all([
    getCurrentUser(),
    supabase.from("fields").select("id, name, code, center_lat, center_lng, notes").eq("id", fieldId).maybeSingle(),
  ]);
  userOrRedirect(currentUser);
  if (!field) notFound();

  return (
    <AppScreen
      title="圃場を編集"
      backHref={`/fields/${field.id}`}
      backLabel="圃場"
      current="settings"
    >
      <Card>
        <CardHeader>
          <CardTitle>圃場の情報</CardTitle>
          <CardDescription>
            圃場記号を変えても、登録済みの株のコードはそのままです
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* 開くたびに DB の値から始める（キャンセルした入力・前回のエラーを残さない） */}
          <ResetOnLeave
            resetKey={JSON.stringify([
              field.name,
              field.code,
              field.center_lat,
              field.center_lng,
              field.notes,
            ])}
          >
            <FieldForm
              mode="edit"
              fieldId={field.id}
              initial={{
                name: field.name,
                code: field.code,
                lat: String(field.center_lat),
                lng: String(field.center_lng),
                notes: field.notes ?? "",
              }}
            />
          </ResetOnLeave>
        </CardContent>
      </Card>
    </AppScreen>
  );
}
