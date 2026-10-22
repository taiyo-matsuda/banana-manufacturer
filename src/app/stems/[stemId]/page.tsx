import { Suspense } from "react";
import { loadStem } from "./load";
import { StemRecordClient } from "./stem-record-client";

// 画面 4「茎の記録入力」（現場の主画面）: ヘッダ（株コード・世代・状態・累計葉数・検算の警告）、
// leaves_new の +0/+1/+2、枯葉処理、現在の葉数、写真（1-7）、イベント（1-8: 出蕾・段数・袋掛け・摘蕾・収穫・被害）、下部に履歴。
// サーバーで観測・イベント・写真を読み、Client Component（stem-record-client.tsx）が端末の outbox の未送信分を重ねる（1-9）。
// 栽培中（active / flowered）でない茎は記録ボタンを出さず、履歴へのリンクだけ。
// params は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
export default function StemPage({ params }: { params: Promise<{ stemId: string }> }) {
  return (
    <main className="flex flex-1 flex-col gap-6 px-4 py-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <Suspense fallback={<p className="text-sm text-zinc-500">読み込み中…</p>}>
          <StemRecord params={params} />
        </Suspense>
      </div>
    </main>
  );
}

async function StemRecord({ params }: { params: Promise<{ stemId: string }> }) {
  const { stemId } = await params;
  const stem = await loadStem(stemId);
  return <StemRecordClient stem={stem} />;
}
