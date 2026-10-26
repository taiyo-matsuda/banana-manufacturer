import Link from "next/link";
import { MapIcon, PencilIcon } from "lucide-react";
import { AppScreen } from "@/components/app/app-screen";
import { DeviceOwner } from "@/components/app/device-store";
import { ForgetMat, RememberMat } from "@/components/app/remember-mat";
import { TargetDamageRecord } from "@/components/app/target-damage-record";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FIRST_STEM_PLANTED_AT_DIFFERS_MESSAGE, firstStemPlantedAtDiffers } from "@/lib/mats/edit";
import type { MatDetailData } from "@/lib/mats/detail";
import { MAT_ORIGIN_LABELS, type MatOriginType } from "@/lib/mats/placement";
import { removedMatLabel } from "@/lib/mats/remove";
import { canAddActiveStem, nextGeneration } from "@/lib/stems/registration";
import { generationLabel } from "@/lib/stems/status";
import { buildHistory } from "@/lib/stems/records";
import { todayJst } from "@/lib/stemEvents";
import { StemHistory } from "@/app/stems/[stemId]/stem-history";
import { recordTargetDamage } from "@/app/fields/[fieldId]/damage/actions";
import { MatStems } from "./mat-stems";
import { StemForm } from "./stem-form";

// 株の詳細（画面 3）の表示（データを受け取るだけ）。サーバー（page.tsx、RSC）とオフラインの殻（2-9、src/app/offline-shell/）で共通。
// 茎一覧（mat-stems.tsx）は端末の outbox の未送信分を重ねる。茎の登録・株の被害はオンライン前提（圏外では無効と理由）
const ORIGIN_LABELS: Record<string, string> = {
  ...MAT_ORIGIN_LABELS,
  sucker_transplant: "株分け",
};

function originLabel(originType: string): string {
  return ORIGIN_LABELS[originType as MatOriginType] ?? originType;
}

// banner: オフラインの殻（2-9）が上部に出す「オフライン表示（最終同期: 日時）」
export function MatDetailScreen({ data, userId, banner }: { data: MatDetailData; userId: string; banner?: React.ReactNode }) {
  const { mat, field, origin } = data;
  // 茎の登録: 栽培中（active / flowered）が 3 本ならフォームを出さず理由を表示（DB の正本はトリガー）
  const addCheck = canAddActiveStem(data.stems);
  const plantedAtDiffers = firstStemPlantedAtDiffers(mat.planted_at, data.stems);
  const next = nextGeneration(data.stems);
  const removed = mat.status === "removed";
  const matHistory = buildHistory([], data.history);

  return (
    <AppScreen title="株の詳細" backHref={field ? `/fields/${field.id}/map` : "/map"} backLabel="地図" current="map">
      {banner}
      <DeviceOwner userId={userId} />
      {removed ? (
        <ForgetMat id={mat.id} />
      ) : (
        <RememberMat id={mat.id} code={mat.code} field={field ? { id: field.id, name: field.name } : null} />
      )}

      {removed && (
        <Alert variant="warning" data-testid="mat-removed">
          <AlertDescription>{removedMatLabel(data.removedEvent)}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <p className="text-sm text-muted-foreground">株</p>
          <CardTitle className="font-mono text-2xl" data-testid="mat-code">
            {mat.code}
          </CardTitle>
          {!removed && (
            <CardAction>
              <Button asChild variant="outline">
                <Link href={`/mats/${mat.id}/edit`} data-testid="mat-edit-link">
                  <PencilIcon aria-hidden="true" />
                  編集
                </Link>
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">品種</dt>
            <dd data-testid="mat-cultivar">{data.cultivarName ?? "（不明）"}</dd>
            <dt className="text-muted-foreground">植え付け日</dt>
            <dd data-testid="mat-planted-at">{mat.planted_at}</dd>
            <dt className="text-muted-foreground">苗の種類</dt>
            <dd data-testid="mat-origin-type">{originLabel(mat.origin_type)}</dd>
            <dt className="text-muted-foreground">由来</dt>
            <dd data-testid="mat-origin">
              {origin ? (
                <Link href={`/mats/${origin.matId}`} className="text-primary underline underline-offset-4" data-testid="mat-origin-link">
                  株 {origin.matCode}（{generationLabel(origin.generation)}）から株分け
                </Link>
              ) : (
                "この位置に植え付け"
              )}
            </dd>
          </dl>
          {plantedAtDiffers && (
            <Alert variant="warning" data-testid="mat-planted-at-differs">
              <AlertDescription>{FIRST_STEM_PLANTED_AT_DIFFERS_MESSAGE}</AlertDescription>
            </Alert>
          )}
          {field && (
            <Button asChild variant="outline">
              <Link href={`/fields/${field.id}/map`} data-testid="mat-map-link">
                <MapIcon aria-hidden="true" />
                <span className="truncate">地図へ（{field.name}）</span>
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>茎</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {data.stemsError ? (
            <p role="alert" className="text-destructive">
              茎を取得できませんでした（{data.stemsError}）
            </p>
          ) : (
            <MatStems stems={data.stems} canRecordSucker={!removed} />
          )}

          {!removed &&
            (addCheck.ok ? (
              <StemForm matId={mat.id} defaultPlantedAt={mat.planted_at} nextGeneration={next.generation} />
            ) : (
              <p className="text-muted-foreground" data-testid="stem-add-blocked">
                {addCheck.reason}
              </p>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>株の記録</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!removed && <TargetDamageRecord targetType="mat" targetId={mat.id} today={todayJst()} action={recordTargetDamage} />}
          <div data-testid="mat-history">
            {data.historyError ? (
              <p role="alert" className="text-destructive">
                株の記録を取得できませんでした（{data.historyError}）
              </p>
            ) : (
              <StemHistory entries={matHistory} />
            )}
          </div>
        </CardContent>
      </Card>
    </AppScreen>
  );
}
