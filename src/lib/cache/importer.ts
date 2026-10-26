// 差分の取り込み（offline-sync.md 5.4・5.7）の本体。純粋な TypeScript で、Supabase（source）と Dexie（store）は注入する。
//
// - 差分: テーブルごとに (updated_at, id) > カーソル の行を order by updated_at, id で PAGE_SIZE 件ずつ取り込む。
//   1 ページごとに行の上書き（bulkPut）とカーソルの更新をまとめて保存する（途中で失敗しても取り込んだ分は残り、次はその続きから）
// - 全件: 全テーブルを全部取ってから、キャッシュを入れ替える（途中で失敗したら前のキャッシュを残す）。
//   初回（meta なし）・持ち主の交代・前回の全件から 24 時間・手動（「全件を取り直す」）のとき
// - 持ち主（organization_id / user_id）が違えば、取り込みの前にキャッシュを消す（他のユーザーの行を残さない）
// - キャッシュに入るのは source が返した行（RLS で見えた自組織の行）だけ
import { advanceCursor, hasNextPage, PAGE_SIZE, startCursor } from "./cursor";
import { CACHE_TABLES, type CacheOwner, type CacheTable, type CachedRow, type SyncCursor, type SyncMeta } from "./types";

export const FULL_RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type CacheSource = {
  // cursor より後の行を (updated_at, id) 順に最大 limit 件。cursor が null なら先頭から。失敗は throw
  fetchPage(table: CacheTable, cursor: SyncCursor | null, limit: number): Promise<CachedRow[]>;
};

export type CacheStore = {
  getMeta(): Promise<SyncMeta | null>;
  getCursor(table: CacheTable): Promise<SyncCursor | null>;
  // 1 ページ分の行の上書きとカーソルの更新（1 トランザクション）
  applyPage(table: CacheTable, rows: CachedRow[], cursor: SyncCursor | null): Promise<void>;
  // 全件の入れ替え（6 表を消して入れ直し、カーソルと meta も置き換える。1 トランザクション）
  replaceAll(rows: Record<CacheTable, CachedRow[]>, cursors: SyncCursor[], meta: SyncMeta): Promise<void>;
  setMeta(meta: SyncMeta): Promise<void>;
  // キャッシュ（6 表・カーソル・meta）を消す。outbox と pendingPhotos は消さない
  clearCache(): Promise<void>;
};

export type MetaExtras = Pick<SyncMeta, "organization_name" | "display_name" | "cultivars">;

export type ImportReason = "first" | "owner-changed" | "stale" | "manual";
export type ImportMode = { mode: "full"; reason: ImportReason } | { mode: "delta" };

export function ownerMatches(meta: Pick<SyncMeta, "organization_id" | "user_id"> | null, owner: CacheOwner): boolean {
  return meta !== null && meta.organization_id === owner.organization_id && meta.user_id === owner.user_id;
}

// 全件か差分かの判定
export function decideImportMode(meta: SyncMeta | null, owner: CacheOwner, now: Date, forceFull = false): ImportMode {
  if (meta === null) return { mode: "full", reason: "first" };
  if (!ownerMatches(meta, owner)) return { mode: "full", reason: "owner-changed" };
  if (forceFull) return { mode: "full", reason: "manual" };
  const last = Date.parse(meta.last_full_at);
  if (Number.isNaN(last) || now.getTime() - last >= FULL_RESYNC_INTERVAL_MS) return { mode: "full", reason: "stale" };
  return { mode: "delta" };
}

export type ImportResult = { mode: ImportMode; counts: Record<CacheTable, number> };

const emptyCounts = (): Record<CacheTable, number> => ({ fields: 0, mats: 0, stems: 0, observations: 0, events: 0, photos: 0 });

// 1 テーブルを cursor の後ろから最後まで（ページごとに onPage）
async function pageThrough(
  source: CacheSource,
  table: CacheTable,
  from: SyncCursor | null,
  pageSize: number,
  onPage: (rows: CachedRow[], cursor: SyncCursor | null) => Promise<void>,
): Promise<SyncCursor | null> {
  let cursor = from;
  let saved = from;
  for (;;) {
    const rows = await source.fetchPage(table, cursor, pageSize);
    const next = advanceCursor(table, cursor, rows);
    await onPage(rows, next);
    saved = next;
    if (!hasNextPage(rows.length, pageSize) || next === null || (cursor !== null && next.updated_at === cursor.updated_at && next.id === cursor.id)) {
      return saved;
    }
    cursor = next;
  }
}

export async function runCacheImport(opts: {
  source: CacheSource;
  store: CacheStore;
  owner: CacheOwner;
  extras: MetaExtras;
  now: () => Date;
  forceFull?: boolean;
  pageSize?: number;
}): Promise<ImportResult> {
  const { source, store, owner, extras, now } = opts;
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const meta = await store.getMeta();
  const mode = decideImportMode(meta, owner, now(), opts.forceFull ?? false);
  const counts = emptyCounts();

  if (mode.mode === "full") {
    // 持ち主が違うキャッシュは、取得の前に消す（取得に失敗しても前のユーザーの行を残さない）
    if (mode.reason === "owner-changed") await store.clearCache();
    const rows = { fields: [], mats: [], stems: [], observations: [], events: [], photos: [] } as Record<CacheTable, CachedRow[]>;
    const cursors: SyncCursor[] = [];
    for (const table of CACHE_TABLES) {
      const last = await pageThrough(source, table, null, pageSize, async (page) => {
        rows[table].push(...page);
      });
      counts[table] = rows[table].length;
      if (last) cursors.push(last);
    }
    const at = now().toISOString();
    await store.replaceAll(rows, cursors, { key: "meta", ...owner, ...extras, last_synced_at: at, last_full_at: at });
    return { mode, counts };
  }

  for (const table of CACHE_TABLES) {
    const saved = await store.getCursor(table);
    await pageThrough(source, table, startCursor(saved), pageSize, async (page, cursor) => {
      counts[table] += page.length;
      // 戻した位置から読むので、保存済みのカーソルより後ろにしか進めない
      const next = advanceCursor(table, saved, page);
      if (page.length > 0) await store.applyPage(table, page, next ?? cursor);
    });
  }
  await store.setMeta({ ...(meta as SyncMeta), ...owner, ...extras, key: "meta", last_synced_at: now().toISOString() });
  return { mode, counts };
}
