import { Suspense } from "react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { DeviceOwner } from "@/components/app/device-store";
import { LinkList, LinkListItem, LinkRow } from "@/components/app/link-list";
import { RecentMats } from "@/components/app/recent-mats";
import { WeeklyList, WeeklyThresholdToggle } from "@/components/app/weekly-list";
import { LocateFixedIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";
import { WEEKLY_HOME_LIMIT } from "@/lib/weekly";
import { fetchWeeklyRows } from "./weekly/data";
import Link from "next/link";

// 画面 1「ホーム」: 組織名、今週見る株（2-7）、近くの株を探す（2-8。圃場の選択 /map?locate=1 → 地図で現在地を取る）、圃場の一覧（タップで圃場の詳細へ）、最近開いた株（端末に残した直近 5 件）。
// 未同期件数はヘッダ（layout の SyncStatus）。「提案」はステップ 3 で追加する。
// 各区画は別の Suspense で、Supabase への問い合わせは並列に走る（PERF-1: 直列の往復を増やさない）。
// ログアウトは設定（/fields）にある。
export default function Home() {
  return (
    <AppScreen title="ホーム" current="home">
      <Suspense fallback={<LoadingText />}>
        <OrganizationHeader />
      </Suspense>
      <WeeklyCard />
      <NearbyCard />
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

// 今週見る株（2-7）: 最初の WEEKLY_HOME_LIMIT 件と「すべて見る（N 件）」→ /weekly。閾値の切り替えは右上
function WeeklyCard() {
  return (
    <Card data-testid="home-weekly">
      <CardHeader>
        <CardTitle>今週見る株</CardTitle>
        <CardAction>
          <WeeklyThresholdToggle />
        </CardAction>
      </CardHeader>
      <CardContent>
        <Suspense fallback={<LoadingText />}>
          <WeeklyRows />
        </Suspense>
      </CardContent>
    </Card>
  );
}

async function WeeklyRows() {
  const { rows, error } = await fetchWeeklyRows();
  if (error) {
    return (
      <p role="alert" className="text-destructive">
        今週見る株を取得できませんでした（{error}）
      </p>
    );
  }
  return <WeeklyList rows={rows} limit={WEEKLY_HOME_LIMIT} />;
}

// 近くの株を探す（2-8）: 地図用の圃場選択に ?locate=1 で行く（圃場が 1 つならその地図へ転送）。
// 地図を開いた直後に現在地を取り、近い順に 3 株を出す。問い合わせはしない（圃場の数は /map が見る）
function NearbyCard() {
  return (
    <Card data-testid="home-nearby">
      <CardContent>
        <Button asChild size="lg" variant="outline" className="w-full">
          <Link href="/map?locate=1" data-testid="home-nearby-link">
            <LocateFixedIcon aria-hidden="true" />
            近くの株を探す
          </Link>
        </Button>
      </CardContent>
    </Card>
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
