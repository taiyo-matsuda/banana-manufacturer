import { Suspense } from "react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { DeviceOwner } from "@/components/app/device-store";
import { RecentMats } from "@/components/app/recent-mats";
import { WeeklyList } from "@/components/app/weekly-list";
import { requireUser } from "@/lib/auth/current-user";
import { createClient } from "@/lib/supabase/server";
import { WEEKLY_HOME_LIMIT } from "@/lib/weekly";
import { FieldsCardView, NearbyCard, OrganizationView, WeeklyCardFrame } from "./home-sections";
import { fetchWeeklyRows } from "./weekly/data";

// 画面 1「ホーム」: 組織名、今週見る株（2-7）、近くの株を探す（2-8。圃場の選択 /map?locate=1 → 地図で現在地を取る）、圃場の一覧（タップで圃場の詳細へ）、最近開いた株（端末に残した直近 5 件）。
// 未同期件数はヘッダ（layout の SyncStatus）。「提案」はステップ 3 で追加する。
// 各区画は別の Suspense で、Supabase への問い合わせは並列に走る（PERF-1: 直列の往復を増やさない）。
// 区画の表示は home-sections.tsx（オフラインの殻 2-9 と共通）。ここはサーバーでのデータの取得だけ。
// ログアウトは設定（/fields）にある。
export default function Home() {
  return (
    <AppScreen title="ホーム" current="home">
      <Suspense fallback={<LoadingText />}>
        <OrganizationHeader />
      </Suspense>
      <WeeklyCardFrame>
        <Suspense fallback={<LoadingText />}>
          <WeeklyRows />
        </Suspense>
      </WeeklyCardFrame>
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
    <>
      {/* 端末に残した「最近開いた株」「直近の圃場」が別のユーザーのものなら消す */}
      <DeviceOwner userId={user.id} />
      <OrganizationView organizationName={org?.name ?? null} displayName={profile?.display_name ?? null} />
    </>
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

async function FieldsCard() {
  const supabase = await createClient();
  const { data: fields, error } = await supabase.from("fields").select("id, name, code").order("name");
  return <FieldsCardView fields={fields ?? []} error={error?.message ?? null} />;
}
