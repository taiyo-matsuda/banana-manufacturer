import { generationLabel, stemStatusLabel } from "@/lib/stems/status";
import type { StemView } from "./load";

// ヘッダ: 株コード、世代、状態、累計葉数（初期葉数 + Σ leaves_new）、検算のずれの警告。履歴画面と共通
export function StemHeader({ stem }: { stem: StemView }) {
  return (
    <header className="flex flex-col gap-2">
      <p className="text-xs text-zinc-500">茎</p>
      <h1 className="text-2xl font-semibold">
        <span className="font-mono" data-testid="stem-mat-code">
          {stem.mat.code}
        </span>
        <span className="ml-3 text-lg" data-testid="stem-generation">
          {generationLabel(stem.generation)}
        </span>
        <span className="ml-2 text-sm font-normal text-zinc-500">第 {stem.generation} 世代</span>
      </h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-zinc-500">状態</dt>
        <dd data-testid="stem-status">{stemStatusLabel(stem.status)}</dd>
        <dt className="text-zinc-500">累計葉数</dt>
        <dd>
          <span className="text-3xl font-semibold" data-testid="stem-cumulative-leaves">
            {stem.cumulative}
          </span>{" "}
          枚
          <span className="ml-2 text-xs text-zinc-500">（初期 {stem.initialLeafCount} 枚）</span>
        </dd>
        {stem.byCheck !== null && (
          <>
            <dt className="text-zinc-500">検算</dt>
            <dd data-testid="stem-leaves-by-check">{stem.byCheck} 枚</dd>
          </>
        )}
      </dl>
      {stem.checkWarning && (
        <p
          role="alert"
          data-testid="leaf-check-warning"
          className="rounded-lg border border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-200"
        >
          {stem.checkWarning}
        </p>
      )}
    </header>
  );
}
