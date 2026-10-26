"use client";

// 読み取りのキャッシュの取り込み（ブラウザ側）。offline-sync.md 5.4・5.7。
//
// - トリガー: 起動時（SyncStatus の登録時。描画を止めないよう少し待ってから）、online、visibilitychange（visible）、
//   同期状態画面の手動ボタン（「今すぐ同期」「全件を取り直す」）、outbox の送信が成功した後（sync-client.ts）
// - 多重実行しない（実行中に要求が来たら「終わったらもう一度」の印だけ。全件の要求は印に残す）
// - オフライン（navigator.onLine === false）・未ログインでは取り込まない。失敗しても要確認にはせず、次のトリガーでやり直す
// - 取得は supabase-js（RLS で自組織の行だけが返る。組織の条件は書かない）。持ち主（user / organization）は
//   ログイン中のセッションと profile から決め、キャッシュの持ち主と違えば消してから全件（importer.ts）
import { cursorFilter } from "../cache/cursor";
import { type CacheSource, type ImportResult, type MetaExtras, runCacheImport } from "../cache/importer";
import type { CacheOwner, CacheTable, CachedRow, SyncMeta } from "../cache/types";
import { cacheStore, getDb, getSyncMeta, hasIndexedDb } from "../db";
import { createClient } from "../supabase/client";
import { isOnline } from "./sync-client";

type SupabaseBrowser = ReturnType<typeof createClient>;

export type CacheSyncState = {
  running: boolean;
  lastResult: ImportResult | null;
  lastError: string | null;
  lastFinishedAt: number | null;
  meta: SyncMeta | null; // 最終同期の日時など（画面の表示用）
};

type Listener = (state: CacheSyncState) => void;

let supabase: SupabaseBrowser | null = null;
let running: Promise<void> | null = null;
let again: { forceFull: boolean } | null = null;
// ログアウトの間は取り込まない（消した直後に書き戻さない）。時刻（epoch ms）まで
let suspendedUntil = 0;
const LOGOUT_SUSPEND_MS = 15_000;
let state: CacheSyncState = { running: false, lastResult: null, lastError: null, lastFinishedAt: null, meta: null };
const listeners = new Set<Listener>();

function setState(next: Partial<CacheSyncState>) {
  state = { ...state, ...next };
  for (const l of listeners) l(state);
}

export function subscribeCacheSync(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCacheSyncState(): CacheSyncState {
  return state;
}

function client(): SupabaseBrowser {
  supabase ??= createClient();
  return supabase;
}

export function supabaseCacheSource(sb: SupabaseBrowser): CacheSource {
  return {
    async fetchPage(table: CacheTable, cursor, limit) {
      let query = sb.from(table).select("*");
      const filter = cursorFilter(cursor);
      if (filter) query = query.or(filter);
      const { data, error } = await query.order("updated_at", { ascending: true }).order("id", { ascending: true }).limit(limit);
      if (error) throw new Error(`[${error.code ?? ""}] ${error.message}`);
      return (data ?? []) as unknown as CachedRow[];
    },
  };
}

// ログイン中のユーザー・組織と、画面の表示用の項目（組織名・表示名・品種）。未ログインなら null
async function currentOwner(sb: SupabaseBrowser): Promise<{ owner: CacheOwner; extras: MetaExtras } | null> {
  const { data: session } = await sb.auth.getSession();
  const userId = session.session?.user.id;
  if (!userId) return null;
  const [{ data: profile, error }, { data: cultivars }] = await Promise.all([
    sb.from("profiles").select("organization_id, display_name, organizations ( name )").eq("id", userId).maybeSingle(),
    sb.from("cultivars").select("id, name").order("name"),
  ]);
  if (error) throw new Error(`[${error.code ?? ""}] ${error.message}`);
  if (!profile?.organization_id) return null;
  const org = profile.organizations as unknown as { name: string } | null;
  return {
    owner: { organization_id: profile.organization_id, user_id: userId },
    extras: { organization_name: org?.name ?? null, display_name: profile.display_name ?? null, cultivars: cultivars ?? [] },
  };
}

export async function refreshCacheMeta(): Promise<SyncMeta | null> {
  if (!hasIndexedDb()) return null;
  const meta = await getSyncMeta();
  setState({ meta });
  return meta;
}

// 取り込みを要求する。実行中なら終わった後にもう一度（全件の要求は残す）
export function requestCacheImport(opts: { forceFull?: boolean } = {}): Promise<void> {
  if (!hasIndexedDb() || Date.now() < suspendedUntil) return Promise.resolve();
  if (running) {
    again = { forceFull: (again?.forceFull ?? false) || (opts.forceFull ?? false) };
    return running;
  }
  running = (async () => {
    setState({ running: true });
    try {
      if (!isOnline()) return;
      const sb = client();
      const who = await currentOwner(sb);
      if (!who) return;
      const result = await runCacheImport({
        source: supabaseCacheSource(sb),
        store: cacheStore(getDb()),
        owner: who.owner,
        extras: who.extras,
        now: () => new Date(),
        forceFull: opts.forceFull,
      });
      setState({ lastResult: result, lastError: null });
    } catch (err) {
      console.warn("キャッシュの取り込みに失敗しました（次のトリガーでやり直します）", err);
      setState({ lastError: err instanceof Error ? err.message : String(err) });
    } finally {
      const meta = await getSyncMeta().catch(() => null);
      running = null;
      setState({ running: false, lastFinishedAt: Date.now(), meta });
      if (again) {
        const next = again;
        again = null;
        void requestCacheImport(next);
      }
    }
  })();
  return running;
}

// 起動時の取り込み: 画面の描画・ハイドレーションを止めないよう、ブラウザが空くのを待ってから
export function requestCacheImportWhenIdle(): () => void {
  if (typeof window === "undefined") return () => {};
  let cancelled = false;
  const start = () => {
    if (!cancelled) void requestCacheImport();
  };
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const timer = setTimeout(() => {
    if (ric) ric(start, { timeout: 2000 });
    else start();
  }, 500);
  return () => {
    cancelled = true;
    clearTimeout(timer);
  };
}

// ログアウト（logout.ts）: 実行中の取り込みの終わりを待ち、しばらく新しい取り込みを始めない
export async function suspendCacheImport(): Promise<void> {
  suspendedUntil = Date.now() + LOGOUT_SUSPEND_MS;
  again = null;
  if (running) await running.catch(() => undefined);
}

// ログアウト時に表示用の状態を初期化する
export function resetCacheSyncState() {
  setState({ lastResult: null, lastError: null, lastFinishedAt: null, meta: null });
}
