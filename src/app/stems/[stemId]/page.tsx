import { Suspense } from "react";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { loadStem } from "./load";
import { StemRecordClient } from "./stem-record-client";

// 画面 4「茎の記録入力」（現場の主画面）: ヘッダ（株コード・世代・状態・累計葉数・検算の警告）、
// leaves_new の +1 / +2（主役）と「増えていない（+0）」（控えめ）、枯葉処理、現在の葉数、写真（1-7）、
// イベント（1-8: 出蕾・段数・袋掛け・摘蕾・収穫・被害）、下部に履歴。
// サーバーで観測・イベント・写真を読み、Client Component（stem-record-client.tsx）が端末の outbox の未送信分を重ねる（1-9）。
// 栽培中（active / flowered）でない茎は記録ボタンを出さず、履歴へのリンクだけ。
// params は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
// 戻る先（株の詳細）は茎を読んでから決まるので、ヘッダも Suspense の中で描く（読み込み中は「戻る」を出さない）。
export default function StemPage({ params }: { params: Promise<{ stemId: string }> }) {
  return (
    <Suspense
      fallback={
        <AppScreen title="茎の記録" current="map">
          <LoadingText />
        </AppScreen>
      }
    >
      <StemRecord params={params} />
    </Suspense>
  );
}

async function StemRecord({ params }: { params: Promise<{ stemId: string }> }) {
  const { stemId } = await params;
  const stem = await loadStem(stemId);
  return (
    <AppScreen title="茎の記録" backHref={`/mats/${stem.mat.id}`} backLabel={`株 ${stem.mat.code}`} current="map">
      <StemRecordClient stem={stem} />
    </AppScreen>
  );
}
