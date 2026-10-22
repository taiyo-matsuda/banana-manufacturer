import { Suspense } from "react";
import Link from "next/link";
import { stemStatusLabel } from "@/lib/stems/status";
import { EventRecord } from "./event-record";
import { LeafRecord } from "./leaf-record";
import { loadStem } from "./load";
import { PhotoCapture } from "./photo-capture";
import { StemHeader } from "./stem-header";
import { StemHistory } from "./stem-history";

// 画面 4「茎の記録入力」（現場の主画面）: ヘッダ（株コード・世代・状態・累計葉数・検算の警告）、
// leaves_new の +0/+1/+2、枯葉処理、現在の葉数、写真（1-7）、イベント（1-8: 出蕾・段数・袋掛け・摘蕾・収穫・被害）、下部に履歴。
// オフライン（1-9）は後のタスクで追加する。
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

  return (
    <article className="flex flex-col gap-6">
      <nav className="flex flex-wrap gap-x-4 text-sm">
        <Link href={`/mats/${stem.mat.id}`} className="text-green-700 underline dark:text-green-400" data-testid="stem-mat-link">
          株 {stem.mat.code} へ
        </Link>
      </nav>

      <StemHeader stem={stem} />

      {stem.canRecord ? (
        <>
          <LeafRecord stemId={stem.id} />
          <PhotoCapture stemId={stem.id} />
          <EventRecord stemId={stem.id} status={stem.status} defaultEarliestAt={stem.latestObservedOn} />
        </>
      ) : (
        <p className="text-sm text-zinc-500" data-testid="record-closed">
          この茎は{stemStatusLabel(stem.status)}のため記録できません。履歴だけ見られます
        </p>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">履歴</h2>
          <Link
            href={`/stems/${stem.id}/history`}
            className="text-sm text-green-700 underline dark:text-green-400"
            data-testid="stem-history-link"
          >
            履歴を開く
          </Link>
        </div>
        <StemHistory entries={stem.history} />
      </section>
    </article>
  );
}
