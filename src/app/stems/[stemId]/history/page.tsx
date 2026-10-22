import { Suspense } from "react";
import Link from "next/link";
import { loadStem } from "../load";
import { StemHeader } from "../stem-header";
import { StemHistory } from "../stem-history";

// 画面 8「茎の履歴」。1-6 では記録入力画面と同じ一覧を出す（写真・推定はステップ 1-7 / 3 で追加）。
// params は Suspense の外で await しない。
export default function StemHistoryPage({ params }: { params: Promise<{ stemId: string }> }) {
  return (
    <main className="flex flex-1 flex-col gap-6 px-4 py-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <Suspense fallback={<p className="text-sm text-zinc-500">読み込み中…</p>}>
          <History params={params} />
        </Suspense>
      </div>
    </main>
  );
}

async function History({ params }: { params: Promise<{ stemId: string }> }) {
  const { stemId } = await params;
  const stem = await loadStem(stemId);
  return (
    <article className="flex flex-col gap-6">
      <nav className="flex flex-wrap gap-x-4 text-sm">
        <Link href={`/stems/${stem.id}`} className="text-green-700 underline dark:text-green-400" data-testid="stem-record-link">
          記録入力へ
        </Link>
        <Link href={`/mats/${stem.mat.id}`} className="text-green-700 underline dark:text-green-400" data-testid="stem-mat-link">
          株 {stem.mat.code} へ
        </Link>
      </nav>
      <StemHeader stem={stem} />
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">履歴</h2>
        <StemHistory entries={stem.history} />
      </section>
    </article>
  );
}
