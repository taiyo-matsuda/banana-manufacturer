import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PlusIcon } from "lucide-react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { LinkList, LinkListItem, LinkRow } from "@/components/app/link-list";
import { LogoutButton } from "@/components/app/logout-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { createClient } from "@/lib/supabase/server";

// 画面 6「圃場の設定」（下部タブ「設定」）: 圃場の一覧と「＋ 圃場を追加」（登録は別画面 /fields/new）、ログアウト。
// 一覧に登録フォームは置かない（UX-1 完了条件 3）。
export default function FieldsPage() {
  return (
    <AppScreen title="圃場" backHref="/" backLabel="ホーム" current="settings">
      <Card>
        <CardHeader>
          <CardTitle>圃場の一覧</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Suspense fallback={<LoadingText />}>
            <FieldList />
          </Suspense>
          <Button asChild variant="outline" size="lg" data-testid="field-add">
            <Link href="/fields/new">
              <PlusIcon aria-hidden="true" />
              圃場を追加
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Separator />

      <section aria-label="アカウント" className="flex flex-col gap-2">
        <LogoutButton />
      </section>
    </AppScreen>
  );
}

async function FieldList() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: fields, error } = await supabase
    .from("fields")
    .select("id, name, code, center_lat, center_lng")
    .order("name");

  if (error) {
    return (
      <p role="alert" className="text-destructive">
        圃場の一覧を取得できませんでした（{error.message}）
      </p>
    );
  }

  if (!fields || fields.length === 0) {
    return (
      <p data-testid="fields-empty" className="text-muted-foreground">
        圃場がまだありません
      </p>
    );
  }

  return (
    <LinkList data-testid="fields-list">
      {fields.map((f) => (
        <LinkListItem key={f.id} data-testid="field-row">
          <LinkRow href={`/fields/${f.id}`}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium" data-testid="field-name">
                {f.name}
              </span>
              <span className="text-sm text-muted-foreground" data-testid="field-center">
                {f.center_lat}, {f.center_lng}
              </span>
            </span>
            <Badge variant="outline" className="font-mono" data-testid="field-code">
              {f.code}
            </Badge>
          </LinkRow>
        </LinkListItem>
      ))}
    </LinkList>
  );
}
