import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { generationLabel, stemStatusLabel } from "@/lib/stems/status";
import type { StemView } from "./load";

// ヘッダ: 株コード、世代、状態、累計葉数（初期葉数 + Σ leaves_new）、検算のずれの警告。履歴画面と共通
export function StemHeader({ stem }: { stem: StemView }) {
  return (
    <Card>
      <CardHeader>
        <p className="text-sm text-muted-foreground">茎</p>
        <h2 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-2xl font-semibold">
          <span className="font-mono" data-testid="stem-mat-code">
            {stem.mat.code}
          </span>
          <span className="text-lg" data-testid="stem-generation">
            {generationLabel(stem.generation)}
          </span>
          <span className="text-sm font-normal text-muted-foreground">第 {stem.generation} 世代</span>
        </h2>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">状態</dt>
          <dd>
            <Badge variant="secondary" data-testid="stem-status">
              {stemStatusLabel(stem.status)}
            </Badge>
          </dd>
          <dt className="text-muted-foreground">累計葉数</dt>
          <dd>
            <span className="text-4xl font-semibold tabular-nums" data-testid="stem-cumulative-leaves">
              {stem.cumulative}
            </span>{" "}
            枚
            <span className="ml-2 text-sm text-muted-foreground">（初期 {stem.initialLeafCount} 枚）</span>
          </dd>
          {stem.byCheck !== null && (
            <>
              <dt className="text-muted-foreground">検算</dt>
              <dd data-testid="stem-leaves-by-check">{stem.byCheck} 枚</dd>
            </>
          )}
        </dl>
        {stem.checkWarning && (
          <Alert variant="warning" data-testid="leaf-check-warning">
            <AlertDescription>{stem.checkWarning}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
