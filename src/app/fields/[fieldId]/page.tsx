import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { MapIcon } from "lucide-react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

// 圃場の詳細: 名前・記号・代表点と地図への導線。土壌分析の入力は後のタスクで追加する。編集は UX-2。
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
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: field } = await supabase
    .from("fields")
    .select("id, name, code, center_lat, center_lng")
    .eq("id", fieldId)
    .maybeSingle();
  if (!field) notFound();

  return (
    <Card>
      <CardHeader>
        <p className="text-sm text-muted-foreground">圃場</p>
        <CardTitle className="text-xl" data-testid="field-detail-name">
          {field.name}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">圃場記号</dt>
          <dd>
            <Badge variant="outline" className="font-mono">
              {field.code}
            </Badge>
          </dd>
          <dt className="text-muted-foreground">代表点</dt>
          <dd className="tabular-nums">
            {field.center_lat}, {field.center_lng}
          </dd>
        </dl>
        <Button asChild size="lg">
          <Link href={`/fields/${field.id}/map`}>
            <MapIcon aria-hidden="true" />
            地図（株の配置）
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
