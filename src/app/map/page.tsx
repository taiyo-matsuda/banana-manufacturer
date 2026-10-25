import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MapIcon } from "lucide-react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { DeviceOwner } from "@/components/app/device-store";
import { LinkList, LinkListItem, LinkRow } from "@/components/app/link-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";

// 地図用の圃場選択（UX-1）。下部タブ「地図」は直近に開いた圃場の地図へ直接行く（端末に記録。bottom-nav.tsx）。
// まだどの圃場も開いていないときだけここに来る。圃場が 1 つならその地図へ転送、複数なら選ぶ（タップで地図へ）。
// 下部タブの強調は「地図」のまま。
// ホームの「近くの株を探す」（2-8）は /map?locate=1 に来る。そのときは選んだ圃場の地図を ?locate=1 で開き、
// 地図を開いた直後に現在地を取る（圃場が 1 つならその地図へ転送）。
// searchParams は Suspense の外で await しない（cacheComponents の静的シェル検証）。
type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

export default function MapTabPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <AppScreen title="地図" current="map">
      <Suspense fallback={<LoadingText />}>
        <FieldPicker searchParams={searchParams} />
      </Suspense>
    </AppScreen>
  );
}

async function FieldPicker({ searchParams }: { searchParams: SearchParams }) {
  const locate = (await searchParams).locate === "1";
  const suffix = locate ? "?locate=1" : "";
  const supabase = await createClient();
  // PERF-1: ユーザーの確認と一覧の select を並べる（直列の往復 2 → 1）
  const [currentUser, { data: fields, error }] = await Promise.all([
    getCurrentUser(),
    supabase.from("fields").select("id, name, code").order("name"),
  ]);
  const user = userOrRedirect(currentUser);
  if (fields && fields.length === 1) redirect(`/fields/${fields[0].id}/map${suffix}`);

  return (
    <Card data-testid="map-field-picker">
      <DeviceOwner userId={user.id} />
      <CardHeader>
        <CardTitle>{locate ? "どの圃場で近くの株を探しますか" : "どの圃場の地図を開きますか"}</CardTitle>
        <CardDescription>
          {locate
            ? "選んだ圃場の地図を開き、現在地から近い株を出します"
            : "次からは、最後に開いた圃場の地図が下部タブ「地図」から直接開きます"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-destructive">
            圃場の一覧を取得できませんでした（{error.message}）
          </p>
        ) : !fields || fields.length === 0 ? (
          <>
            <p className="text-muted-foreground">圃場がまだありません</p>
            <Button asChild variant="outline" size="lg">
              <Link href="/fields/new">圃場を追加</Link>
            </Button>
          </>
        ) : (
          <LinkList>
            {fields.map((f) => (
              <LinkListItem key={f.id} data-testid="map-field-row">
                <LinkRow href={`/fields/${f.id}/map${suffix}`}>
                  <span className="flex min-w-0 items-center gap-2">
                    <MapIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate font-medium">{f.name}</span>
                  </span>
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
