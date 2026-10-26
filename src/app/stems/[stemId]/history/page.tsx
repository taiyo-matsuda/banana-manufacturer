import { Suspense } from "react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { loadStem } from "../load";
import { StemHistoryClient } from "./stem-history-client";

// 画面 8「茎の履歴」。記録入力画面と同じ一覧を出す（推定はステップ 3 で追加）。
// 端末の outbox の未送信分も「未同期」の印付きで重ねる（2-9。stem-history-client.tsx）。
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
      <StemHistoryClient stem={stem} />
    </AppScreen>
  );
}
