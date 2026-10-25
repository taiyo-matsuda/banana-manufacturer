import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MapIcon, PencilIcon, SproutIcon } from "lucide-react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { SyncFieldName } from "@/components/app/remember-mat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";

// 圃場の詳細: 名前・記号・代表点・メモと地図への導線、編集（/fields/[fieldId]/edit、UX-2）への導線、
// 施肥の一括入力（/fields/[fieldId]/fertilize、2-4）への導線。
// 土壌分析の入力は後のタスクで追加する。
// params は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
export default function FieldDetailPage({ params }: { params: Promise<{ fieldId: string }> }) {
  return (
    <AppScreen title="圃場の詳細" backHref="/fields" backLabel="圃場" current="settings">
      <Suspense fallback={<LoadingText />}>
        <FieldDetail params={params} />
      </Suspense>
    </AppScreen>
  );
}

async function FieldDetail({ params }: { params: Promise<{ fieldId: string }> }) {
  const { fieldId } = await params;
  const supabase = await createClient();
  // PERF-1: ユーザーの確認と圃場の select を並べる（直列の往復 2 → 1）
  const [currentUser, { data: field }] = await Promise.all([
    getCurrentUser(),
    supabase.from("fields").select("id, name, code, center_lat, center_lng, notes").eq("id", fieldId).maybeSingle(),
  ]);
  userOrRedirect(currentUser);
  if (!field) notFound();

  return (
    <Card>
      <SyncFieldName id={field.id} name={field.name} />
      <CardHeader>
        <p className="text-sm text-muted-foreground">圃場</p>
        <CardTitle className="text-xl break-words" data-testid="field-detail-name">
          {field.name}
        </CardTitle>
        <CardAction>
          <Button asChild variant="outline">
            <Link href={`/fields/${field.id}/edit`} data-testid="field-edit-link">
              <PencilIcon aria-hidden="true" />
              編集
            </Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">圃場記号</dt>
          <dd>
            <Badge variant="outline" className="font-mono" data-testid="field-detail-code">
              {field.code}
            </Badge>
          </dd>
          <dt className="text-muted-foreground">代表点</dt>
          <dd className="tabular-nums" data-testid="field-detail-center">
            {field.center_lat}, {field.center_lng}
          </dd>
          {field.notes && (
            <>
              <dt className="self-start text-muted-foreground">メモ</dt>
              <dd className="whitespace-pre-wrap break-words" data-testid="field-detail-notes">
                {field.notes}
              </dd>
            </>
          )}
        </dl>
        <Button asChild size="lg">
          <Link href={`/fields/${field.id}/map`}>
            <MapIcon aria-hidden="true" />
            地図（株の配置）
          </Link>
        </Button>
        <Button asChild size="lg" variant="outline">
          <Link href={`/fields/${field.id}/fertilize`} data-testid="field-fertilize-link">
            <SproutIcon aria-hidden="true" />
            施肥を記録
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
