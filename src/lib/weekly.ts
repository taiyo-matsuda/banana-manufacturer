// 今週見る株（2-7、画面 1、要件 4.2・UC-2・要確認 16）の純粋ロジック。UI・DB に依存しない。
//
// 入力は茎ごとの行（view weekly_stems、0016）: 株・圃場の表示項目と、その茎の「最後の leaves_new の日時」と leaves_new の合計
// （どちらも superseded_by が null の観測だけ。観測は全件を引かない）。出力は並んだ株の一覧。
//
// - 対象: 撤去していない株のうち、栽培中（active）・出蕾済み（flowered）の茎を持つ株
// - 代表の茎: 株ごとに「最も進んだ茎」（flowered を優先、同じ状態なら世代の若い＝古い茎、同じなら started_at の早い茎）
// - 経過日数: 株の対象の茎のうち、最も古い「最後の leaves_new の日」（＝その株で一番見ていない茎）から今日までの日数。
//   観測が 1 件もない茎は茎の started_at（植え付け・採用日）から。日付は日本時間（Asia/Tokyo）で数える
// - 表示: 経過日数が閾値（既定 7 日、設定で 14 日）以上の株。出蕾済みの茎を持つ株は閾値に関係なく出す
// - 今日（日本時間）その株のどれかの茎へ leaves_new を記録していたら出さない（巡回の進み具合が分かる）
// - 並び: 出蕾済みの株が先（出蕾日の古い順）、次にそれ以外を経過日数の長い順、同じなら株コード順
// - 未同期（outbox）の記録は applyOutboxToWeekly で重ねてから computeWeekly に渡す（圏外で記録しても消える）
import { nextStatus, todayJst } from "./stemEvents";
import type { OutboxItem } from "./offline/types";

export const WEEKLY_THRESHOLDS = [7, 14] as const;
export type WeeklyThreshold = (typeof WEEKLY_THRESHOLDS)[number];
export const DEFAULT_WEEKLY_THRESHOLD: WeeklyThreshold = 7;
export const WEEKLY_THRESHOLD_KEY = "weekly-threshold";
// ホームに出す件数（残りは /weekly）
export const WEEKLY_HOME_LIMIT = 20;

// view weekly_stems の 1 行（茎ごと）
export type WeeklyStemRow = {
  stem_id: string;
  mat_id: string;
  mat_code: string;
  mat_status: string;
  field_id: string;
  field_name: string;
  generation: number;
  status: string;
  started_at: string; // YYYY-MM-DD
  bud_emerged_at: string | null; // YYYY-MM-DD
  initial_leaf_count: number;
  last_leaves_new_at: string | null; // ISO（timestamptz）
  leaves_new_sum: number;
};

export type WeeklyItem = {
  matId: string;
  matCode: string;
  fieldId: string;
  fieldName: string;
  stemId: string; // 代表の茎
  stemStatus: string; // 代表の茎の状態
  cumulativeLeaves: number; // 代表の茎の累計葉数
  daysSince: number; // 経過日数
  flowered: boolean; // 出蕾済みの茎を持つ
  budEmergedAt: string | null; // 出蕾済みの茎のうち最も古い出蕾日
};

const TARGET_STATUSES = ["active", "flowered"];

export function parseWeeklyThreshold(raw: string | null | undefined): WeeklyThreshold {
  const n = Number(raw);
  return (WEEKLY_THRESHOLDS as readonly number[]).includes(n) ? (n as WeeklyThreshold) : DEFAULT_WEEKLY_THRESHOLD;
}

// YYYY-MM-DD 同士の日数の差（to - from）
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

// 経過日数の表示（「今日」「9 日前」）
export function daysSinceLabel(days: number): string {
  return days <= 0 ? "今日" : `${days} 日前`;
}

// 茎の「最後に見た日」（日本時間の日付）。観測がなければ started_at
function lastSeenDate(row: WeeklyStemRow): string {
  return row.last_leaves_new_at ? todayJst(new Date(row.last_leaves_new_at)) : row.started_at;
}

// 代表の茎の比較（先に来るほど進んでいる）
function compareRepresentative(a: WeeklyStemRow, b: WeeklyStemRow): number {
  const fa = a.status === "flowered" ? 0 : 1;
  const fb = b.status === "flowered" ? 0 : 1;
  return fa - fb || a.generation - b.generation || a.started_at.localeCompare(b.started_at) || a.stem_id.localeCompare(b.stem_id);
}

export function computeWeekly(
  rows: readonly WeeklyStemRow[],
  today: string, // 日本時間の今日（YYYY-MM-DD）
  threshold: number,
): WeeklyItem[] {
  const byMat = new Map<string, WeeklyStemRow[]>();
  for (const r of rows) {
    if (r.mat_status === "removed") continue;
    if (!TARGET_STATUSES.includes(r.status)) continue;
    const list = byMat.get(r.mat_id);
    if (list) list.push(r);
    else byMat.set(r.mat_id, [r]);
  }

  const items: WeeklyItem[] = [];
  for (const stems of byMat.values()) {
    const seen = stems.map(lastSeenDate);
    // 今日どれかの茎に leaves_new を記録した株は出さない（観測のある茎だけ。started_at が今日の茎は数えない）
    if (stems.some((s) => s.last_leaves_new_at !== null && todayJst(new Date(s.last_leaves_new_at)) >= today)) continue;
    const oldest = seen.reduce((min, d) => (d < min ? d : min));
    const daysSince = Math.max(0, daysBetween(oldest, today));
    const floweredStems = stems.filter((s) => s.status === "flowered");
    const flowered = floweredStems.length > 0;
    if (!flowered && daysSince < threshold) continue;

    const rep = [...stems].sort(compareRepresentative)[0];
    const budDates = floweredStems.map((s) => s.bud_emerged_at).filter((d): d is string => d !== null).sort();
    items.push({
      matId: rep.mat_id,
      matCode: rep.mat_code,
      fieldId: rep.field_id,
      fieldName: rep.field_name,
      stemId: rep.stem_id,
      stemStatus: rep.status,
      cumulativeLeaves: rep.initial_leaf_count + Number(rep.leaves_new_sum),
      daysSince,
      flowered,
      budEmergedAt: budDates[0] ?? null,
    });
  }

  return items.sort((a, b) => {
    if (a.flowered !== b.flowered) return a.flowered ? -1 : 1;
    if (a.flowered) {
      // 出蕾日の古い順（出蕾日が分からないものは後）
      const ba = a.budEmergedAt ?? "9999-99-99";
      const bb = b.budEmergedAt ?? "9999-99-99";
      if (ba !== bb) return ba.localeCompare(bb);
    } else if (a.daysSince !== b.daysSince) {
      return b.daysSince - a.daysSince;
    }
    return a.matCode.localeCompare(b.matCode, "ja", { numeric: true }) || a.matId.localeCompare(b.matId);
  });
}

// 未同期（outbox）の記録を重ねる（1-9 の重ね合わせと同じ考え方）。
// - 未送信の leaves_new: その茎の最後の日時（新しいほう）と合計に足す
// - 未送信の茎イベント（record_stem_event）: 見かけの状態に反映（出蕾 → flowered と出蕾日、収穫・喪失 → 対象外）
// - 同じ id は 1 回だけ。一覧にない茎（未同期の吸芽の採用など）は扱わない
export function applyOutboxToWeekly(rows: readonly WeeklyStemRow[], items: readonly OutboxItem[]): WeeklyStemRow[] {
  const result = rows.map((r) => ({ ...r }));
  const byStem = new Map(result.map((r) => [r.stem_id, r]));
  const seen = new Set<string>();
  const sorted = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  for (const item of sorted) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const row = byStem.get(item.stem_id);
    if (!row) continue;
    if (item.kind === "observation") {
      if (item.payload.type !== "leaves_new") continue;
      const at = item.payload.observed_at;
      if (row.last_leaves_new_at === null || new Date(at).getTime() > new Date(row.last_leaves_new_at).getTime()) {
        row.last_leaves_new_at = at;
      }
      row.leaves_new_sum = Number(row.leaves_new_sum) + item.payload.value;
    } else if (item.kind === "event" && item.payload.method === "record_stem_event") {
      const p = item.payload;
      const next = nextStatus(row.status, p.type, p.payload);
      if (next === null) continue;
      if (next === "flowered" && row.status !== "flowered") row.bud_emerged_at = todayJst(new Date(p.occurred_at));
      row.status = next;
    }
  }
  return result;
}

// 送信済みで outbox から消えたが、サーバーの一覧（props）にまだ反映されていない記録を保持するときの鍵（useHeldItems）。
// leaves_new の観測は「茎 id @ 観測日（日本時間）」。サーバーの一覧のその茎の最後の日が同じ日になれば反映済み（weeklyServerKeys と対）
export function weeklyHoldKey(item: OutboxItem): string | null {
  if (item.kind === "observation" && item.payload.type === "leaves_new") {
    return `${item.stem_id}@${todayJst(new Date(item.payload.observed_at))}`;
  }
  return null;
}

// サーバーの一覧に反映済みの鍵の集合（weeklyHoldKey と対）。rows が同じなら同じ集合を使う（useMemo）
export function weeklyServerKeys(rows: readonly WeeklyStemRow[]): Set<string> {
  const keys = new Set<string>();
  for (const r of rows) {
    if (r.last_leaves_new_at !== null) keys.add(`${r.stem_id}@${todayJst(new Date(r.last_leaves_new_at))}`);
  }
  return keys;
}
