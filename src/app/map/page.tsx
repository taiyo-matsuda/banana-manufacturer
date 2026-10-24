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
import { createClient } from "@/lib/supabase/server";

// 地図用の圃場選択（UX-1）。下部タブ「地図」は直近に開いた圃場の地図へ直接行く（端末に記録。bottom-nav.tsx）。
// まだどの圃場も開いていないときだけここに来る。圃場が 1 つならその地図へ転送、複数なら選ぶ（タップで地図へ）。
// 下部タブの強調は「地図」のまま。
export default function MapTabPage() {
  return (
    <AppScreen title="地図" current="map">
      <Suspense fallback={<LoadingText />}>
        <FieldPicker />
      </Suspense>
    </AppScreen>
  );
}

async function FieldPicker() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: fields, error } = await supabase.from("fields").select("id, name, code").order("name");
  if (fields && fields.length === 1) redirect(`/fields/${fields[0].id}/map`);

  return (
    <Card data-testid="map-field-picker">
      <DeviceOwner userId={user.id} />
      <CardHeader>
        <CardTitle>どの圃場の地図を開きますか</CardTitle>
        <CardDescription>次からは、最後に開いた圃場の地図が下部タブ「地図」から直接開きます</CardDescription>
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
                <LinkRow href={`/fields/${f.id}/map`}>
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
