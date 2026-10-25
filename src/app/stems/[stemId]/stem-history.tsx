import { Badge } from "@/components/ui/badge";
import { formatDateTime, type HistoryEntry } from "@/lib/stems/records";
import { CorrectRecord } from "./correct-record";
import { PhotoThumb } from "./photo-thumb";

// 茎の履歴（画面 4 の下部と画面 8 で共通）。観測・イベント・写真を新しい順に並べる。
// 削除・編集の操作は置かない（追記のみ）。訂正（2-6）: 訂正できる種類の、訂正済みでない行に「訂正」ボタン。
// 訂正済み（superseded_by あり）の行は値を打ち消し線にして「訂正済み → 新しい値」、訂正で追加された行には「訂正」の印。
// 写真はサムネイルを出し、タップで原寸（縮小済み）を表示する。
// correctable: 茎の画面（記録入力・履歴）だけ true。圃場・株の記録（2-4・2-5）は訂正の対象外なのでボタンを出さない
export function StemHistory({ entries, correctable = false }: { entries: HistoryEntry[]; correctable?: boolean }) {
  if (entries.length === 0) {
    return (
      <p className="text-muted-foreground" data-testid="history-empty">
        記録なし
      </p>
    );
  }
  return (
    <ol className="flex flex-col divide-y" data-testid="history-list">
      {entries.map((e) => (
        <li
          key={e.key}
          className={`flex items-center justify-between gap-3 py-3 ${e.superseded ? "text-muted-foreground" : ""}`}
          data-testid="history-item"
          data-kind={e.kind}
          data-type={e.type}
          data-id={e.id}
          data-superseded={e.superseded ? "true" : undefined}
          data-correction={e.isCorrection ? "true" : undefined}
          data-pending={e.pending ? "true" : undefined}
          data-photo-id={e.photo?.id}
        >
          <span className="flex min-w-0 items-center gap-3">
            {e.photo && <PhotoThumb photo={e.photo} alt={`${e.label}（${e.valueText}）${formatDateTime(e.at)}`} />}
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`font-medium ${e.superseded ? "line-through" : ""}`} data-testid="history-label">
                {e.label}
              </span>
              {e.valueText && (
                <span className={e.superseded ? "line-through" : undefined} data-testid="history-value">
                  {e.valueText}
                </span>
              )}
              {e.note && (
                <span className="basis-full break-words text-muted-foreground" data-testid="history-note">
                  {e.note}
                </span>
              )}
              {e.superseded && (
                <span className="text-sm" data-testid="history-superseded">
                  訂正済み{e.correctedTo !== null ? ` → ${e.correctedTo}` : ""}
                </span>
              )}
              {e.isCorrection && (
                <Badge variant="secondary" data-testid="history-correction">
                  訂正
                </Badge>
              )}
              {e.pending && (
                <Badge variant="outline" className="border-warning-foreground/40 bg-warning text-warning-foreground" data-testid="history-pending">
                  未同期
                </Badge>
              )}
            </span>
          </span>
          <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
            <time dateTime={e.at.toISOString()} data-testid="history-at">
              {formatDateTime(e.at)}
            </time>
            {e.by && <span data-testid="history-by">{e.by}</span>}
            {correctable && <CorrectRecord entry={e} />}
          </span>
        </li>
      ))}
    </ol>
  );
}
