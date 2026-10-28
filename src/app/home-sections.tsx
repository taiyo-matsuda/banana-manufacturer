import Link from "next/link";
import { LocateFixedIcon } from "lucide-react";
import { LinkList, LinkListItem, LinkRow } from "@/components/app/link-list";
import { WeeklyThresholdToggle } from "@/components/app/weekly-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// ホーム（画面 1）の区画の表示（データを受け取るだけ）。サーバー（page.tsx、RSC）とオフラインの殻（2-9）で共通。

export function OrganizationView({ organizationName, displayName }: { organizationName: string | null; displayName: string | null }) {
  return (
    <section className="flex flex-col gap-1">
      <p className="text-sm text-muted-foreground">組織</p>
      <p className="text-xl font-semibold" data-testid="organization-name">
        {organizationName ?? "（組織が未設定）"}
      </p>
      {displayName && <p className="text-muted-foreground">{displayName}</p>}
    </section>
  );
}

// 提案（3-4）の枠。中身（RecommendationList）は呼び出し側。オフラインの殻では提案を読まないので理由を出す
export function RecommendationsCardFrame({ children }: { children: React.ReactNode }) {
  return (
    <Card data-testid="home-recommendations">
      <CardHeader>
        <CardTitle>提案</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// 今週見る株（2-7）の枠。中身（WeeklyList）は呼び出し側
export function WeeklyCardFrame({ children }: { children: React.ReactNode }) {
  return (
    <Card data-testid="home-weekly">
      <CardHeader>
        <CardTitle>今週見る株</CardTitle>
        <CardAction>
          <WeeklyThresholdToggle />
        </CardAction>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// 近くの株を探す（2-8）: 地図用の圃場選択に ?locate=1 で行く（圃場が 1 つならその地図へ転送）。
// 地図を開いた直後に現在地を取り、近い順に 3 株を出す。問い合わせはしない（圃場の数は /map が見る）
export function NearbyCard() {
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

export function FieldsCardView({ fields, error }: { fields: { id: string; name: string; code: string }[]; error: string | null }) {
  return (
    <Card data-testid="home-fields">
      <CardHeader>
        <CardTitle>圃場</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error ? (
          <p role="alert" className="text-destructive">
            圃場の一覧を取得できませんでした（{error}）
          </p>
        ) : fields.length === 0 ? (
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
