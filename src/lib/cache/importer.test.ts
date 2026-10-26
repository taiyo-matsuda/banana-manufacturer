import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { AppDb, cacheStore, clearCache, clearOutbox } from "../db";
import { newObservationItem } from "../offline/items";
import { isAfterCursor } from "./cursor";
import { type CacheSource, decideImportMode, FULL_RESYNC_INTERVAL_MS, runCacheImport } from "./importer";
import { CACHE_TABLES, type CacheTable, type CachedRow, type SyncMeta } from "./types";

// サーバー（RLS で絞られた後の行）の代わり。order by updated_at, id と (updated_at, id) > cursor を再現する
class FakeServer implements CacheSource {
  rows: Record<CacheTable, CachedRow[]> = { fields: [], mats: [], stems: [], observations: [], events: [], photos: [] };
  calls = 0;
  failAt: number | null = null; // この回数目の fetchPage で失敗する
  async fetchPage(table: CacheTable, cursor: { updated_at: string; id: string } | null, limit: number) {
    this.calls += 1;
    if (this.failAt !== null && this.calls >= this.failAt) throw new TypeError("Failed to fetch");
    return this.rows[table]
      .filter((r) => isAfterCursor(r, cursor))
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
}

const ORG = "org-a";
const owner = { organization_id: ORG, user_id: "user-1" };
const extras = { organization_name: "テスト農園 A", display_name: "A", cultivars: [{ id: "c1", name: "ドワーフナムワ" }] };
const field = (id: string, updated_at: string, name = id) =>
  ({ id, organization_id: ORG, updated_at, created_at: updated_at, name, code: id.toUpperCase(), center_lat: 26.5, center_lng: 127.9, notes: null }) as CachedRow;
const obs = (id: string, updated_at: string, superseded_by: string | null = null) =>
  ({ id, organization_id: ORG, updated_at, created_at: updated_at, stem_id: "s1", type: "leaves_new", value: 1, observed_at: updated_at, observed_by: "user-1", note: null, superseded_by }) as CachedRow;

let db: AppDb;
let seq = 0;
let server: FakeServer;
let clock: Date;
const now = () => clock;

beforeEach(async () => {
  seq += 1;
  db = new AppDb(`cache-test-${seq}`);
  await db.open();
  server = new FakeServer();
  clock = new Date("2026-10-26T00:00:00Z");
});

const run = (opts: { forceFull?: boolean; pageSize?: number; who?: typeof owner } = {}) =>
  runCacheImport({ source: server, store: cacheStore(db), owner: opts.who ?? owner, extras, now, forceFull: opts.forceFull, pageSize: opts.pageSize ?? 2 });

describe("decideImportMode", () => {
  const meta = (last_full_at: string, o = owner): SyncMeta => ({ key: "meta", ...o, ...extras, last_synced_at: last_full_at, last_full_at });
  it("初回・持ち主の交代・24 時間・手動は全件、それ以外は差分", () => {
    const t = new Date("2026-10-26T00:00:00Z");
    expect(decideImportMode(null, owner, t)).toEqual({ mode: "full", reason: "first" });
    expect(decideImportMode(meta("2026-10-25T12:00:00Z", { ...owner, user_id: "other" }), owner, t)).toEqual({ mode: "full", reason: "owner-changed" });
    expect(decideImportMode(meta("2026-10-25T12:00:00Z", { ...owner, organization_id: "org-b" }), owner, t)).toEqual({ mode: "full", reason: "owner-changed" });
    expect(decideImportMode(meta(new Date(t.getTime() - FULL_RESYNC_INTERVAL_MS).toISOString()), owner, t)).toEqual({ mode: "full", reason: "stale" });
    expect(decideImportMode(meta("2026-10-25T12:00:00Z"), owner, t, true)).toEqual({ mode: "full", reason: "manual" });
    expect(decideImportMode(meta("2026-10-25T12:00:00Z"), owner, t)).toEqual({ mode: "delta" });
  });
});

describe("runCacheImport", () => {
  it("初回は全件。同じ updated_at の行が多くても (updated_at, id) のページングで取りこぼし・重複がない", async () => {
    // 0017 の適用時は既存の行が全部同じ updated_at になる
    const same = "2026-10-25T00:00:00.123+00:00";
    server.rows.fields = ["f1", "f2", "f3", "f4", "f5"].map((id) => field(id, same));
    server.rows.observations = [obs("o1", same), obs("o2", "2026-10-25T00:00:01+00:00")];
    const res = await run({ pageSize: 2 });
    expect(res.mode).toEqual({ mode: "full", reason: "first" });
    expect(res.counts.fields).toBe(5);
    expect((await db.fields.toArray()).map((f) => f.id).sort()).toEqual(["f1", "f2", "f3", "f4", "f5"]);
    expect(await db.observations.count()).toBe(2);
    expect(await db.syncCursors.get("fields")).toEqual({ table: "fields", updated_at: same, id: "f5" });
    const meta = await db.syncMeta.get("meta");
    expect(meta).toMatchObject({ ...owner, organization_name: "テスト農園 A", last_synced_at: clock.toISOString(), last_full_at: clock.toISOString() });
  });

  it("差分: 追加された行と更新された行（訂正で superseded_by が入った行）だけを取り込む", async () => {
    server.rows.observations = [obs("o1", "2026-10-25T00:00:00+00:00")];
    await run();
    clock = new Date("2026-10-26T01:00:00Z");
    // 訂正: 元の行の superseded_by が入り updated_at が進む。新しい行が追加される
    server.rows.observations = [obs("o1", "2026-10-26T00:30:00+00:00", "o2"), obs("o2", "2026-10-26T00:30:00+00:00")];
    const before = server.calls;
    const res = await run();
    expect(res.mode).toEqual({ mode: "delta" });
    expect(res.counts.observations).toBe(2);
    expect((await db.observations.get("o1"))?.superseded_by).toBe("o2");
    expect(await db.observations.get("o2")).toBeTruthy();
    // 6 表それぞれ 1 ページずつ（件数が上限未満なら終わり）。観測はちょうど上限（2 件）なので次のページ（0 件）も読む
    expect(server.calls - before).toBe(CACHE_TABLES.length + 1);
    expect((await db.syncMeta.get("meta"))?.last_synced_at).toBe(clock.toISOString());
    expect((await db.syncMeta.get("meta"))?.last_full_at).toBe("2026-10-26T00:00:00.000Z");
  });

  it("差分: カーソルより少し古い時刻で後からコミットされた行も拾う（開始時に戻す）", async () => {
    server.rows.observations = [obs("o1", "2026-10-26T00:10:00+00:00")];
    await run();
    // o0 は o1 より前に始まったトランザクションで、o1 の取り込みの後にコミットされた
    server.rows.observations.push(obs("o0", "2026-10-26T00:09:30+00:00"));
    clock = new Date("2026-10-26T00:20:00Z");
    await run();
    expect(await db.observations.get("o0")).toBeTruthy();
    // カーソルは後ろに戻らない
    expect((await db.syncCursors.get("observations"))?.id).toBe("o1");
  });

  it("24 時間たつと全件を取り直し、サーバーで消えた行（E2E の掃除など）がキャッシュからも消える", async () => {
    server.rows.fields = [field("f1", "2026-10-25T00:00:00+00:00"), field("f2", "2026-10-25T00:00:00+00:00")];
    await run();
    server.rows.fields = [field("f2", "2026-10-25T00:00:00+00:00")];
    clock = new Date("2026-10-26T12:00:00Z");
    expect((await run()).mode).toEqual({ mode: "delta" });
    expect(await db.fields.count()).toBe(2); // 差分では消えたことが分からない
    clock = new Date("2026-10-27T00:00:01Z");
    expect((await run()).mode).toEqual({ mode: "full", reason: "stale" });
    expect((await db.fields.toArray()).map((f) => f.id)).toEqual(["f2"]);
  });

  it("手動の「全件を取り直す」", async () => {
    server.rows.fields = [field("f1", "2026-10-25T00:00:00+00:00")];
    await run();
    server.rows.fields = [];
    expect((await run({ forceFull: true })).mode).toEqual({ mode: "full", reason: "manual" });
    expect(await db.fields.count()).toBe(0);
  });

  it("全件の取得が途中で失敗したら、前のキャッシュを残す", async () => {
    server.rows.fields = [field("f1", "2026-10-25T00:00:00+00:00")];
    await run();
    server.rows.fields = [field("f9", "2026-10-25T00:00:00+00:00")];
    server.failAt = server.calls + 3;
    await expect(run({ forceFull: true })).rejects.toThrow("Failed to fetch");
    expect((await db.fields.toArray()).map((f) => f.id)).toEqual(["f1"]);
    expect((await db.syncMeta.get("meta"))?.last_full_at).toBe(clock.toISOString());
  });

  it("持ち主（ユーザー・組織）が違えば、取得の前にキャッシュを消す（取得に失敗しても前のユーザーの行を残さない）", async () => {
    server.rows.fields = [field("f1", "2026-10-25T00:00:00+00:00")];
    await run();
    server.failAt = server.calls + 1;
    await expect(run({ who: { organization_id: "org-b", user_id: "user-2" } })).rejects.toThrow();
    expect(await db.fields.count()).toBe(0);
    expect(await db.syncMeta.get("meta")).toBeUndefined();
    server.failAt = null;
    await run({ who: { organization_id: "org-b", user_id: "user-2" } });
    expect(await db.syncMeta.get("meta")).toMatchObject({ organization_id: "org-b", user_id: "user-2" });
  });

  it("キャッシュの入れ替え・消去では outbox を消さない（消すのはログアウトの clearOutbox だけ）", async () => {
    await db.outbox.add(
      newObservationItem({ id: "x", createdAt: new Date(), stemId: "s1", type: "leaves_new", value: 1, observedAt: new Date(), userId: "user-1" }),
    );
    server.rows.fields = [field("f1", "2026-10-25T00:00:00+00:00")];
    await run();
    await run({ forceFull: true });
    await clearCache(db);
    expect(await db.fields.count()).toBe(0);
    expect(await db.syncCursors.count()).toBe(0);
    expect(await db.outbox.count()).toBe(1);
    await clearOutbox(db);
    expect(await db.outbox.count()).toBe(0);
  });
});
