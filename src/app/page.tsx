import { Suspense } from "react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { DeviceOwner } from "@/components/app/device-store";
import { LinkList, LinkListItem, LinkRow } from "@/components/app/link-list";
import { RecentMats } from "@/components/app/recent-mats";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";

// 画面 1「ホーム」: 組織名、圃場の一覧（タップで圃場の詳細へ）、最近開いた株（端末に残した直近 5 件）。
// 未同期件数はヘッダ（layout の SyncStatus）。「今週見る株」「提案」はステップ 2 / 3 で追加する。
// ログアウトは設定（/fields）にある。
export default function Home() {
  return (
    <AppScreen title="ホーム" current="home">
      <Suspense fallback={<LoadingText />}>
        <OrganizationHeader />
      </Suspense>
      <Suspense fallback={<LoadingText />}>
        <FieldsCard />
      </Suspense>
      <RecentMats />
    </AppScreen>
  );
}

async function OrganizationHeader() {
  const supabase = await createClient();
  // 自分の profile は user.id で引くので、getUser の後（直列の往復 2 回）
  const user = await requireUser();

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, organizations ( name )")
    .eq("id", user.id)
    .maybeSingle();

  const org = profile?.organizations as { name: string } | null | undefined;

  return (
    <section className="flex flex-col gap-1">
      {/* 端末に残した「最近開いた株」「直近の圃場」が別のユーザーのものなら消す */}
      <DeviceOwner userId={user.id} />
      <p className="text-sm text-muted-foreground">組織</p>
      <p className="text-xl font-semibold" data-testid="organization-name">
        {org?.name ?? "（組織が未設定）"}
      </p>
      {profile?.display_name && <p className="text-muted-foreground">{profile.display_name}</p>}
    </section>
  );
}

async function FieldsCard() {
  const supabase = await createClient();
  const { data: fields, error } = await supabase.from("fields").select("id, name, code").order("name");

  return (
    <Card data-testid="home-fields">
      <CardHeader>
        <CardTitle>圃場</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? (
          <p role="alert" className="text-destructive">
            圃場の一覧を取得できませんでした（{error.message}）
          </p>
        ) : !fields || fields.length === 0 ? (
          <>
            <p className="text-muted-foreground" data-testid="home-fields-empty">
              圃場がまだありません
            </p>
            <Button asChild variant="outline">
              <Link href="/fields/new">圃場を追加</Link>
            </Button>
          </>
        ) : (
          <LinkList>
            {fields.map((f) => (
              <LinkListItem key={f.id} data-testid="home-field-row">
                <LinkRow href={`/fields/${f.id}`}>
                  <span className="truncate font-medium">{f.name}</span>
                  <Badge variant="outline" className="font-mono">
                    {f.code}
                  </Badge>
                </LinkRow>
              </LinkListItem>
            ))}
          </LinkList>
        )}
      </CardContent>
    </Card>
  );
}
