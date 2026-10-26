"use client";

import { usePathname } from "next/navigation";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { CloudOffIcon } from "lucide-react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { DeviceOwner } from "@/components/app/device-store";
import { LinkList, LinkListItem, LinkRow } from "@/components/app/link-list";
import { RecentMats } from "@/components/app/recent-mats";
import { WeeklyList } from "@/components/app/weekly-list";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { matchShellRoute, type ShellRoute } from "@/lib/cache/shell-route";
import type { SyncMeta } from "@/lib/cache/types";
import {
  fieldDetailFromCache,
  fieldMapFromCache,
  homeFields,
  matDetailFromCache,
  stemFromCache,
  weeklyRowsFromCache,
} from "@/lib/cache/views";
import { getDb, readFieldSnapshot, readHomeSnapshot, readMatSnapshot, readStemSnapshot } from "@/lib/db";
import { nearbyStemLabel } from "@/lib/nearby";
import { useLiveQuery } from "@/lib/offline/use-live-query";
import { useOnline } from "@/lib/offline/use-online";
import { formatDateTime } from "@/lib/stems/records";
import { buildStemView } from "@/lib/stems/view";
import { WEEKLY_HOME_LIMIT } from "@/lib/weekly";
import { FieldDetailView } from "@/app/fields/[fieldId]/field-detail-view";
import { FieldsCardView, NearbyCard, OrganizationView, WeeklyCardFrame } from "@/app/home-sections";
import { MatDetailScreen } from "@/app/mats/[matId]/mat-detail-view";
import { StemHistoryClient } from "@/app/stems/[stemId]/history/stem-history-client";
import { StemRecordClient } from "@/app/stems/[stemId]/stem-record-client";

// オフラインの殻（2-9、offline-sync.md 5.5）。Service Worker が、対象の URL（/、/fields/[id]、/fields/[id]/map、/mats/[id]、
// /stems/[id]、/stems/[id]/history）へのナビゲーションで「ネットワークに届かず、ナビゲーションのキャッシュにも無い」ときに
// この画面の HTML を返す（URL はそのまま）。ここで URL を読み、端末のキャッシュ（Dexie）から画面のデータを組み立てて、
// 既存の画面の部品（オンラインの RSC と共通の表示部品）で描く。記録は従来どおり outbox に積む（重ね合わせも同じ）。
// - 上部に「オフライン表示（最終同期: 日時）」。キャッシュに無い・一度も同期していないときは理由を出す
// - 殻の中の画面の移動（株 → 茎など）は殻の中で完結させる（RSC の取得は圏外で失敗するため）。
//   リンクのクリックを横取りし、圏外なら history.pushState で URL だけ変えて描き直す（Next.js のルーターは URL の変更を
//   usePathname に反映する）。オンラインなら通常の読み込み（サーバーの画面）にする
export function OfflineShell() {
  const hydrated = useHydrated();
  if (!hydrated) {
    // サーバーで描いた HTML（/offline-shell）と最初のクライアント描画を揃える。URL を読むのはハイドレーションの後
    return (
      <AppScreen title="読み込み中">
        <LoadingText />
      </AppScreen>
    );
  }
  return <ShellRouter />;
}

const noopSubscribe = () => () => {};
function useHydrated(): boolean {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

function ShellRouter() {
  const pathname = usePathname();
  const route = matchShellRoute(pathname);
  const meta = useLiveQuery<SyncMeta | null | undefined>(async () => (await getDb().syncMeta.get("meta")) ?? null, [], undefined);
  useShellNavigation();

  if (meta === undefined) {
    return (
      <AppScreen title="読み込み中">
        <LoadingText />
      </AppScreen>
    );
  }
  const banner = <OfflineBanner meta={meta} />;
  if (!route) return <MissingScreen title="圏外です" banner={banner} reason="この画面はオフラインでは開けません。" />;
  if (!meta) return <MissingScreen title={routeTitle(route)} banner={banner} reason={NO_DATA} />;
  return <ShellScreen key={pathname} route={route} meta={meta} banner={banner} />;
}

const NO_DATA = "この画面のデータは端末にありません。オンラインで一度同期してください";

function routeTitle(route: ShellRoute): string {
  switch (route.kind) {
    case "home":
      return "ホーム";
    case "field":
      return "圃場の詳細";
    case "map":
      return "地図";
    case "mat":
      return "株の詳細";
    case "stem":
      return "茎の記録";
    case "history":
      return "茎の履歴";
  }
}

// 殻の中のリンクのクリックを横取りする（Next.js の Link は defaultPrevented ならクライアント遷移しない）
function useShellNavigation() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      e.preventDefault();
      if (navigator.onLine !== false || !matchShellRoute(url.pathname)) {
        // オンライン（サーバーの画面を開く）か、殻の対象でない画面（Service Worker がキャッシュか /offline を返す）
        window.location.assign(url.href);
        return;
      }
      if (url.pathname + url.search === window.location.pathname + window.location.search) return;
      window.history.pushState(null, "", url.pathname + url.search);
      window.scrollTo(0, 0);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
}

function OfflineBanner({ meta }: { meta: SyncMeta | null }) {
  const online = useOnline();
  return (
    <Alert variant="warning" data-testid="offline-shell-banner">
      <CloudOffIcon aria-hidden="true" />
      <AlertDescription className="flex flex-col gap-2">
        <span>
          オフライン表示（最終同期:{" "}
          <span data-testid="offline-shell-synced-at">{meta ? formatDateTime(new Date(meta.last_synced_at)) : "まだ同期していません"}</span>）
        </span>
        {online && (
          <Button type="button" variant="outline" onClick={() => window.location.reload()} data-testid="offline-shell-reload">
            最新の画面を開く
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

function MissingScreen({ title, banner, reason }: { title: string; banner: React.ReactNode; reason: string }) {
  return (
    <AppScreen title={title} backHref="/" backLabel="ホーム">
      {banner}
      <Card data-testid="offline-shell-missing">
        <CardContent>
          <p>{reason}</p>
        </CardContent>
      </Card>
    </AppScreen>
  );
}

function ShellScreen({ route, meta, banner }: { route: ShellRoute; meta: SyncMeta; banner: React.ReactNode }) {
  switch (route.kind) {
    case "home":
      return <HomeShell meta={meta} banner={banner} />;
    case "field":
      return <FieldShell fieldId={route.fieldId} banner={banner} />;
    case "map":
      return <MapShell fieldId={route.fieldId} banner={banner} />;
    case "mat":
      return <MatShell matId={route.matId} meta={meta} banner={banner} />;
    case "stem":
    case "history":
      return <StemShell stemId={route.stemId} history={route.kind === "history"} meta={meta} banner={banner} />;
  }
}

// キャッシュの読み込み（liveQuery: 取り込みが終わる・記録が送られると描き直す）。undefined は読み込み中
function useCached<T>(load: () => Promise<T>, deps: readonly unknown[]): T | undefined {
  return useLiveQuery<T | undefined>(load, deps, undefined);
}

function HomeShell({ meta, banner }: { meta: SyncMeta; banner: React.ReactNode }) {
  const data = useCached(async () => {
    const snap = await readHomeSnapshot();
    return { fields: homeFields(snap), weekly: weeklyRowsFromCache(snap) };
  }, []);
  return (
    <AppScreen title="ホーム" current="home">
      {banner}
      <DeviceOwner userId={meta.user_id} />
      <OrganizationView organizationName={meta.organization_name} displayName={meta.display_name} />
      <WeeklyCardFrame>{data ? <WeeklyList rows={data.weekly} limit={WEEKLY_HOME_LIMIT} /> : <LoadingText />}</WeeklyCardFrame>
      <NearbyCard />
      {data ? <FieldsCardView fields={data.fields} error={null} /> : <LoadingText />}
      <RecentMats />
    </AppScreen>
  );
}

function FieldShell({ fieldId, banner }: { fieldId: string; banner: React.ReactNode }) {
  const data = useCached(async () => fieldDetailFromCache(await readFieldSnapshot(fieldId), fieldId), [fieldId]);
  if (data === undefined) return <LoadingScreen title="圃場の詳細" />;
  if (data === null) return <MissingScreen title="圃場の詳細" banner={banner} reason={NO_DATA} />;
  return (
    <AppScreen title="圃場の詳細" backHref="/fields" backLabel="圃場" current="settings">
      {banner}
      <FieldDetailView data={data} />
    </AppScreen>
  );
}

// 地図: 空中写真のタイルはオフラインでは出ないので、理由と株の一覧（株の詳細へ）を出す
function MapShell({ fieldId, banner }: { fieldId: string; banner: React.ReactNode }) {
  const data = useCached(async () => fieldMapFromCache(await readFieldSnapshot(fieldId), fieldId), [fieldId]);
  if (data === undefined) return <LoadingScreen title="地図" />;
  if (data === null) return <MissingScreen title="地図" banner={banner} reason={NO_DATA} />;
  return (
    <AppScreen
      title={`${data.field.name}（${data.field.code}）`}
      titleTestId="map-field-name"
      backHref={`/fields/${data.field.id}`}
      backLabel="圃場"
      current="map"
    >
      {banner}
      <Card data-testid="offline-map-unavailable">
        <CardContent>
          <p>地図はオフラインでは表示できません。下の一覧から株を選んでください。</p>
        </CardContent>
      </Card>
      {data.mats.length === 0 ? (
        <p className="text-muted-foreground" data-testid="offline-map-empty">
          株がありません
        </p>
      ) : (
        <LinkList data-testid="offline-map-mats">
          {data.mats.map((m) => (
            <LinkListItem key={m.id} data-testid="offline-map-mat" data-mat-id={m.id}>
              <LinkRow href={`/mats/${m.id}`}>
                <span className="font-mono text-lg font-medium">{m.code}</span>
                <span className="text-sm text-muted-foreground">{nearbyStemLabel(m.stemStatus)}</span>
              </LinkRow>
            </LinkListItem>
          ))}
        </LinkList>
      )}
    </AppScreen>
  );
}

function MatShell({ matId, meta, banner }: { matId: string; meta: SyncMeta; banner: React.ReactNode }) {
  const data = useCached(async () => matDetailFromCache(await readMatSnapshot(matId), matId, meta.cultivars), [matId, meta.cultivars]);
  if (data === undefined) return <LoadingScreen title="株の詳細" />;
  if (data === null) return <MissingScreen title="株の詳細" banner={banner} reason={NO_DATA} />;
  return <MatDetailScreen data={data} userId={meta.user_id} banner={banner} />;
}

function StemShell({ stemId, history, meta, banner }: { stemId: string; history: boolean; meta: SyncMeta; banner: React.ReactNode }) {
  const title = history ? "茎の履歴" : "茎の記録";
  const input = useCached(async () => stemFromCache(await readStemSnapshot(stemId), stemId, meta), [stemId, meta.user_id]);
  const stem = useMemo(() => (input ? buildStemView(input) : input), [input]);
  if (stem === undefined) return <LoadingScreen title={title} />;
  if (stem === null) return <MissingScreen title={title} banner={banner} reason={NO_DATA} />;
  return history ? (
    <AppScreen title={title} backHref={`/stems/${stem.id}`} backLabel="記録入力" current="map">
      {banner}
      <StemHistoryClient stem={stem} />
    </AppScreen>
  ) : (
    <AppScreen title={title} backHref={`/mats/${stem.mat.id}`} backLabel={`株 ${stem.mat.code}`} current="map">
      {banner}
      <StemRecordClient stem={stem} />
    </AppScreen>
  );
}

function LoadingScreen({ title }: { title: string }) {
  return (
    <AppScreen title={title}>
      <LoadingText />
    </AppScreen>
  );
}
