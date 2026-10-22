import { formatDateTime, type HistoryEntry } from "@/lib/stems/records";
import { PhotoThumb } from "./photo-thumb";

// 茎の履歴（画面 4 の下部と画面 8 で共通）。観測・イベント・写真を新しい順に並べる。
// 編集・削除の操作は置かない（追記のみ）。訂正済み（superseded_by あり）は打ち消し表示。
// 写真はサムネイルを出し、タップで原寸（縮小済み）を表示する。
export function StemHistory({ entries }: { entries: HistoryEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-zinc-500" data-testid="history-empty">
        記録なし
      </p>
    );
  }
  return (
    <ol className="flex flex-col divide-y divide-zinc-200 dark:divide-zinc-800" data-testid="history-list">
      {entries.map((e) => (
        <li
          key={e.key}
          className={`flex items-center justify-between gap-3 py-2 text-sm ${e.superseded ? "text-zinc-400 line-through" : ""}`}
          data-testid="history-item"
          data-kind={e.kind}
          data-type={e.type}
          data-superseded={e.superseded ? "true" : undefined}
          data-photo-id={e.photo?.id}
        >
          <span className="flex items-center gap-3">
            {e.photo && <PhotoThumb photo={e.photo} alt={`${e.label}（${e.valueText}）${formatDateTime(e.at)}`} />}
            <span>
              <span className="font-medium" data-testid="history-label">
                {e.label}
              </span>
              {e.valueText && (
                <span className="ml-2" data-testid="history-value">
                  {e.valueText}
                </span>
              )}
              {e.superseded && <span className="ml-2 text-xs">訂正済み</span>}
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end text-xs text-zinc-500">
            <time dateTime={e.at.toISOString()} data-testid="history-at">
              {formatDateTime(e.at)}
            </time>
            {e.by && <span data-testid="history-by">{e.by}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
