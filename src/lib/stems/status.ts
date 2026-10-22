// 茎の状態（stems.status）の表示文言。UI・DB に依存しない。

export const STEM_STATUSES = [
  "sucker",
  "active",
  "flowered",
  "harvested",
  "removed",
  "transplanted",
  "lost",
] as const;
export type StemStatus = (typeof STEM_STATUSES)[number];

export const STEM_STATUS_LABELS: Record<StemStatus, string> = {
  sucker: "吸芽",
  active: "栽培中",
  flowered: "出蕾済み",
  harvested: "収穫済み",
  removed: "除去",
  transplanted: "株分け済み",
  lost: "喪失",
};

export function stemStatusLabel(status: string): string {
  return (STEM_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

// 世代（親=1, 子=2, 孫=3 …）の表示
export function generationLabel(generation: number): string {
  if (generation === 1) return "親";
  if (generation === 2) return "子";
  if (generation === 3) return "孫";
  return `${generation} 代目`;
}

// 世代順（generation 昇順。同じ世代は started_at の早い順）に並べる。元の配列は変えない
export function sortStemsByGeneration<T extends { generation: number; started_at: string }>(
  stems: readonly T[],
): T[] {
  return [...stems].sort(
    (a, b) => a.generation - b.generation || a.started_at.localeCompare(b.started_at),
  );
}
