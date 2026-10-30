import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  forecastUnavailableLabel,
  weekRelativeLabel,
  type ForecastRow,
  type ForecastSummary,
  type ForecastUnavailableRow,
} from "@/lib/forecast";
import { formatMonthDay, formatRange } from "@/lib/prediction/harvest";
import { generationLabel } from "@/lib/stems/status";
import { NeedsReviewBadge } from "./needs-review-badge";

// 予測一覧（3-6、画面 7）の表。集計は src/lib/forecast.ts の buildForecast（純粋関数）。
// - 週ごとの表: 週（月〜日）・収穫予定（本数）・要確認（別枠）。重量はステップ 4
// - 茎ごとの表: 株コード（茎の画面へ）・圃場・出蕾日・収穫予測（幅）・要確認
// - スマホ幅では茎ごとの表の行を縦に積む（列の見出しは各セルの左に出す）。md 以上は通常の表
const th = "px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground";
const td = "px-3 py-2 align-top";
// スマホ幅: 行を枠付きのブロックに、セルを「見出し: 値」の 1 行に
const stackRow = "max-md:block max-md:border-t max-md:py-2 first:max-md:border-t-0";
const stackCell = "max-md:flex max-md:gap-3 max-md:py-1";
const cellLabel = "w-24 shrink-0 text-sm text-muted-foreground md:hidden";

export function ForecastView({ summary }: { summary: ForecastSummary }) {
  const empty = summary.rows.length === 0 && summary.unavailable.length === 0;
  return (
    <div className="flex flex-col gap-4" data-testid="forecast-view">
      <WeeksCard summary={summary} />
      {empty ? (
        <p className="text-muted-foreground" data-testid="forecast-empty">
          出蕾済みの茎はありません
        </p>
      ) : (
        <>
          {summary.rows.length > 0 && <StemsCard rows={summary.rows} />}
          {summary.unavailable.length > 0 && <UnavailableCard rows={summary.unavailable} />}
        </>
      )}
    </div>
  );
}

function WeeksCard({ summary }: { summary: ForecastSummary }) {
  const { weeks, overdue, total, thisWeekStart } = summary;
  return (
    <Card data-testid="forecast-weeks">
      <CardHeader>
        <CardTitle>週ごとの収穫予定</CardTitle>
        <CardDescription>
          収穫予測日の週（月曜〜日曜）に数えます。要確認（大きな被害の記録がある茎）は別枠です。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {weeks.length === 0 && overdue.count + overdue.needsReview === 0 ? (
          <p className="text-muted-foreground" data-testid="forecast-weeks-empty">
            収穫予測日の出ている茎はありません
          </p>
        ) : (
          <table className="w-full border-collapse text-base">
            <thead>
              <tr className="border-b">
                <th scope="col" className={th}>
                  週
                </th>
                <th scope="col" className={`${th} text-right`}>
                  収穫予定
                </th>
                <th scope="col" className={`${th} text-right`}>
                  要確認（別枠）
                </th>
              </tr>
            </thead>
            <tbody>
              {(overdue.count > 0 || overdue.needsReview > 0) && (
                <tr className="border-b" data-testid="forecast-week-overdue" data-count={overdue.count} data-needs-review={overdue.needsReview}>
                  <th scope="row" className={`${td} text-left font-normal`}>
                    予測日を過ぎた（未収穫）
                  </th>
                  <CountCell value={overdue.count} testId="forecast-week-count" />
                  <CountCell value={overdue.needsReview} testId="forecast-week-needs-review" />
                </tr>
              )}
              {weeks.map((w) => {
                const rel = weekRelativeLabel(w.weekStart, thisWeekStart);
                return (
                  <tr
                    key={w.weekStart}
                    className="border-b"
                    data-testid="forecast-week"
                    data-week-start={w.weekStart}
                    data-count={w.count}
                    data-needs-review={w.needsReview}
                  >
                    <th scope="row" className={`${td} text-left font-normal`}>
                      <span data-testid="forecast-week-label">{formatRange(w.weekStart, w.weekEnd)}</span>
                      {rel && <span className="ml-2 text-sm text-muted-foreground">{rel}</span>}
                    </th>
                    <CountCell value={w.count} testId="forecast-week-count" />
                    <CountCell value={w.needsReview} testId="forecast-week-needs-review" />
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr data-testid="forecast-total" data-count={total.count} data-needs-review={total.needsReview}>
                <th scope="row" className={`${td} text-left`}>
                  合計
                </th>
                <CountCell value={total.count} testId="forecast-total-count" strong />
                <CountCell value={total.needsReview} testId="forecast-total-needs-review" strong />
              </tr>
            </tfoot>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

function CountCell({ value, testId, strong = false }: { value: number; testId: string; strong?: boolean }) {
  return (
    <td
      className={`${td} text-right tabular-nums ${strong ? "font-semibold" : ""} ${value === 0 ? "text-muted-foreground" : ""}`}
      data-testid={testId}
    >
      {value} 本
    </td>
  );
}

function StemLink({ row }: { row: { stemId: string; matCode: string; generation: number } }) {
  return (
    <Link href={`/stems/${row.stemId}`} className="inline-flex min-h-11 items-center gap-2 whitespace-nowrap text-primary underline-offset-4 hover:underline">
      <span className="font-mono font-medium" data-testid="forecast-stem-code">
        {row.matCode}
      </span>
      <span className="text-sm text-muted-foreground">{generationLabel(row.generation)}</span>
    </Link>
  );
}

function StemsCard({ rows }: { rows: ForecastRow[] }) {
  return (
    <Card data-testid="forecast-stems">
      <CardHeader>
        <CardTitle>茎ごとの収穫予測</CardTitle>
        <CardDescription>収穫予測日の早い順です。株コードから茎の画面を開けます。</CardDescription>
      </CardHeader>
      <CardContent>
        <table className="w-full border-collapse text-base">
          <thead className="max-md:sr-only">
            <tr className="border-b">
              <th scope="col" className={th}>
                株
              </th>
              <th scope="col" className={th}>
                圃場
              </th>
              <th scope="col" className={th}>
                出蕾日
              </th>
              <th scope="col" className={th}>
                収穫予測（幅）
              </th>
              <th scope="col" className={th}>
                要確認
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.stemId}
                className={`border-b md:last:border-b-0 ${stackRow}`}
                data-testid="forecast-stem"
                data-stem-id={r.stemId}
                data-mat-code={r.matCode}
                data-value-date={r.valueDate}
                data-week-start={r.weekStart}
                data-needs-review={r.needsReview ? "true" : "false"}
                data-overdue={r.overdue ? "true" : "false"}
              >
                <td className={`${td} ${stackCell}`}>
                  <span className={cellLabel}>株</span>
                  <StemLink row={r} />
                </td>
                <td className={`${td} ${stackCell}`} data-testid="forecast-stem-field">
                  <span className={cellLabel}>圃場</span>
                  <span className="break-all">{r.fieldName}</span>
                </td>
                <td className={`${td} ${stackCell}`} data-testid="forecast-stem-bud">
                  <span className={cellLabel}>出蕾日</span>
                  <span className="whitespace-nowrap">{r.budDate ? formatMonthDay(r.budDate) : "—"}</span>
                </td>
                <td className={`${td} ${stackCell}`} data-testid="forecast-stem-harvest">
                  <span className={cellLabel}>収穫予測</span>
                  <span className="flex flex-col">
                    <span className="whitespace-nowrap">
                      {formatMonthDay(r.valueDate)}ごろ{r.overdue && <span className="ml-2 text-sm text-muted-foreground">予測日を過ぎた</span>}
                    </span>
                    <span className="text-sm whitespace-nowrap text-muted-foreground">（{formatRange(r.lowerDate, r.upperDate)}）</span>
                  </span>
                </td>
                <td className={`${td} ${stackCell} ${r.needsReview ? "" : "max-md:hidden"}`}>
                  <span className={cellLabel}>要確認</span>
                  {r.needsReview ? <NeedsReviewBadge data-testid="forecast-stem-needs-review" /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function UnavailableCard({ rows }: { rows: ForecastUnavailableRow[] }) {
  return (
    <Card data-testid="forecast-unavailable">
      <CardHeader>
        <CardTitle>予測できない茎（{rows.length} 本）</CardTitle>
        <CardDescription>出蕾済みですが収穫予測日が出ていないため、週ごとの本数に数えていません。</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y">
          {rows.map((r) => (
            <li
              key={r.stemId}
              className="flex flex-col gap-1 py-2"
              data-testid="forecast-unavailable-stem"
              data-stem-id={r.stemId}
              data-mat-code={r.matCode}
              data-reason={r.reason}
            >
              <span className="flex flex-wrap items-center gap-2">
                <StemLink row={r} />
                <span className="break-all">{r.fieldName}</span>
                {r.budDate && <span className="text-sm text-muted-foreground">出蕾 {formatMonthDay(r.budDate)}</span>}
                {r.needsReview && <NeedsReviewBadge />}
              </span>
              <span className="text-sm text-muted-foreground" data-testid="forecast-unavailable-reason">
                {forecastUnavailableLabel(r.reason)}
                {r.reasonDate ? `（${formatMonthDay(r.reasonDate)}ごろ）` : ""}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
