// 圃場の詳細に出す「気温: 最終取得 ◯月◯日 ◯:◯◯（◯日分）」の文言。純粋関数。

export type WeatherSyncStatusRow = {
  last_run_at: string;
  last_days: number;
  last_error: string | null; // 要約（summary.ts）
  last_success_at: string | null; // 最後に成功した（エラーなし、または 1 日以上保存した）取り込み
  last_success_days: number | null;
};

export type WeatherStatusView =
  | { state: "pending"; text: string }
  | { state: "ok"; text: string }
  | { state: "error"; text: string; error: string; errorAt: string };

const jstDateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: false,
});

// 日本時間の「10月26日 6:05」
export function formatJstMonthDayTime(at: string | Date): string {
  const parts = jstDateTime.formatToParts(typeof at === "string" ? new Date(at) : at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")}月${get("day")}日 ${Number(get("hour"))}:${get("minute")}`;
}

export function weatherStatusView(status: WeatherSyncStatusRow | null): WeatherStatusView {
  if (!status) return { state: "pending", text: "気温: 取り込み待ち" };
  const text =
    status.last_success_at !== null
      ? `気温: 最終取得 ${formatJstMonthDayTime(status.last_success_at)}（${(status.last_success_days ?? 0).toLocaleString("ja-JP")}日分）`
      : "気温: まだ取得できていません";
  if (status.last_error) {
    return { state: "error", text, error: status.last_error, errorAt: formatJstMonthDayTime(status.last_run_at) };
  }
  return { state: "ok", text };
}
