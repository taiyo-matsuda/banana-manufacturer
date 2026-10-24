import { Suspense } from "react";
import Link from "next/link";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { loadStem } from "../load";
import { StemHeader } from "../stem-header";
import { StemHistory } from "../stem-history";

// 画面 8「茎の履歴」。記録入力画面と同じ一覧を出す（推定はステップ 3 で追加）。
// params は Suspense の外で await しない。戻る先（記録入力）は茎を読んでから決まるので、ヘッダも Suspense の中で描く。
export default function StemHistoryPage({ params }: { params: Promise<{ stemId: string }> }) {
  return (
    <Suspense
      fallback={
        <AppScreen title="茎の履歴" current="map">
          <LoadingText />
        </AppScreen>
      }
    >
      <History params={params} />
    </Suspense>
  );
}

async function History({ params }: { params: Promise<{ stemId: string }> }) {
  const { stemId } = await params;
  const stem = await loadStem(stemId);
  return (
    <AppScreen title="茎の履歴" backHref={`/stems/${stem.id}`} backLabel="記録入力" current="map">
      <StemHeader stem={stem} />
      <div className="flex gap-3">
        <Button asChild variant="outline" className="flex-1">
          <Link href={`/stems/${stem.id}`} data-testid="stem-record-link">
            記録入力へ
          </Link>
        </Button>
        <Button asChild variant="outline" className="flex-1">
          <Link href={`/mats/${stem.mat.id}`} data-testid="stem-mat-link">
            株 {stem.mat.code} へ
          </Link>
        </Button>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>履歴</CardTitle>
        </CardHeader>
        <CardContent>
          <StemHistory entries={stem.history} />
        </CardContent>
      </Card>
    </AppScreen>
  );
}
