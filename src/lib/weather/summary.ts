// 取り込みの失敗を、圃場の詳細に出す短い要約にする（weather_sync_status.last_error）。純粋関数。
// 詳細（期間ごとのエラー）はサーバーのログに出す。画面には API ごとに 1 つの理由と、欠けた日数だけ。

export type SyncFailure = {
  kind: "forecast" | "archive" | "other";
  message: string;
  days: number; // この失敗で取れなかった日数（other は 0）
};

export const MAX_SUMMARY_LENGTH = 200;

// エラー文から短い理由を取り出す
export function shortReason(message: string): string {
  const http = message.match(/HTTP (\d{3})/);
  if (http) return `HTTP ${http[1]}`;
  if (message.includes("接続できません")) return "接続できません";
  if (message.includes("形が想定と違います") || message.includes("JSON ではありません")) return "応答の形が想定と違います";
  return message.length > 60 ? `${message.slice(0, 60)}…` : message;
}

const API_LABEL = { forecast: "予報 API", archive: "過去 API" } as const;

export function summarizeSyncFailures(failures: readonly SyncFailure[]): string | null {
  if (failures.length === 0) return null;
  const parts: string[] = [];
  for (const kind of ["archive", "forecast"] as const) {
    const list = failures.filter((f) => f.kind === kind);
    if (list.length === 0) continue;
    const reasons = [...new Set(list.map((f) => shortReason(f.message)))];
    const days = list.reduce((n, f) => n + f.days, 0);
    parts.push(
      `Open-Meteo の${API_LABEL[kind]} から取得できませんでした（${reasons.slice(0, 2).join("、")}${reasons.length > 2 ? " ほか" : ""}）。欠けた日 ${days.toLocaleString("ja-JP")} 日`,
    );
  }
  const others = failures.filter((f) => f.kind === "other");
  if (others.length > 0) parts.push(shortReason(others[0].message));
  const text = parts.join("。");
  return text.length > MAX_SUMMARY_LENGTH ? `${text.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : text;
}
