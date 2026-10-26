import Link from "next/link";
import { MapIcon, PencilIcon, SproutIcon } from "lucide-react";
import { SyncFieldName } from "@/components/app/remember-mat";
import { TargetDamageRecord } from "@/components/app/target-damage-record";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { FieldDetailData } from "@/lib/fields/detail";
import { buildHistory } from "@/lib/stems/records";
import { todayJst } from "@/lib/stemEvents";
import { StemHistory } from "@/app/stems/[stemId]/stem-history";
import { recordTargetDamage } from "./damage/actions";

// 圃場の詳細の表示（データを受け取るだけ）。サーバー（page.tsx、RSC）とオフラインの殻（2-9、src/app/offline-shell/）で共通。
// 圃場の被害の記録（TargetDamageRecord）はオンライン前提（圏外ではボタンを無効にして理由を出す。2-5）
export function FieldDetailView({ data }: { data: FieldDetailData }) {
  const { field } = data;
  return (
    <>
      <Card>
        <SyncFieldName id={field.id} name={field.name} />
        <CardHeader>
          <p className="text-sm text-muted-foreground">圃場</p>
          <CardTitle className="text-xl break-words" data-testid="field-detail-name">
            {field.name}
          </CardTitle>
          <CardAction>
            <Button asChild variant="outline">
              <Link href={`/fields/${field.id}/edit`} data-testid="field-edit-link">
                <PencilIcon aria-hidden="true" />
                編集
              </Link>
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">圃場記号</dt>
            <dd>
              <Badge variant="outline" className="font-mono" data-testid="field-detail-code">
                {field.code}
              </Badge>
            </dd>
            <dt className="text-muted-foreground">代表点</dt>
            <dd className="tabular-nums" data-testid="field-detail-center">
              {field.center_lat}, {field.center_lng}
            </dd>
            {field.notes && (
              <>
                <dt className="self-start text-muted-foreground">メモ</dt>
                <dd className="whitespace-pre-wrap break-words" data-testid="field-detail-notes">
                  {field.notes}
                </dd>
              </>
            )}
          </dl>
          <Button asChild size="lg">
            <Link href={`/fields/${field.id}/map`}>
              <MapIcon aria-hidden="true" />
              地図（株の配置）
            </Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href={`/fields/${field.id}/fertilize`} data-testid="field-fertilize-link">
              <SproutIcon aria-hidden="true" />
              施肥を記録
            </Link>
          </Button>
          <TargetDamageRecord
            targetType="field"
            targetId={field.id}
            today={todayJst()}
            action={recordTargetDamage}
            bulkHrefBase={`/fields/${field.id}/damage/`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>圃場の記録</CardTitle>
        </CardHeader>
        <CardContent data-testid="field-history">
          {data.historyError ? (
            <p role="alert" className="text-destructive">
              圃場の記録を取得できませんでした（{data.historyError}）
            </p>
          ) : (
            <StemHistory entries={buildHistory([], data.history)} />
          )}
        </CardContent>
      </Card>
    </>
  );
}
