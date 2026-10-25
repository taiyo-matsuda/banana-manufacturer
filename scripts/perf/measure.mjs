// PERF-1: 本番（または PERF_BASE_URL）の画面表示と +1 の記録の往復を測る。
//
//   node scripts/perf/measure.mjs before        # 結果は scripts/perf/results/before-<日時>.json
//   PERF_BASE_URL=http://127.0.0.1:3000 node scripts/perf/measure.mjs local
//
// - テスト農園 A（.env.local の E2E_EMAIL / E2E_PASSWORD）で、ブラウザからのログインは 1 回だけ（Supabase Auth のレート制限）。
//   データの用意はログインしたブラウザの Cookie からセッションを取り出し、supabase-js で行う（2 回目のログインをしない）
// - 用意する圃場の名前は「E2E」で始める（E2E の setup の掃除 e2e_cleanup_fields で消える）。本番組織のデータには触れない
// - 各画面を RUNS 回、ページ全体の読み込み（page.goto）で開き、
//   「ナビゲーション開始から主要な要素が表示されるまで」（performance.now()）と TTFB（navigation の responseStart）を取る
// - 茎の画面で +1 を押してから未同期件数が 0 に戻るまで（synced）と、その後の router.refresh() の応答が終わるまで（refreshed）を RUNS 回
// - 応答ヘッダの x-vercel-id（本番では `kix1::…` とエッジしか出ない）と Server-Timing（proxy が付ける。desc が proxy の実行リージョン）も残す
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
loadEnv({ path: path.join(ROOT, ".env.local"), quiet: true });

const LABEL = process.argv[2] ?? "run";
const BASE = (process.env.PERF_BASE_URL ?? "https://banana-manufacturer-8f7t.vercel.app").replace(/\/$/, "");
const RUNS = Number(process.env.PERF_RUNS ?? 5);
const SUPABASE_URL = need("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_KEY = need("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const EMAIL = need("E2E_EMAIL");
const PASSWORD = need("E2E_PASSWORD");

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} がありません（.env.local）`);
  return v;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round = (x) => Math.round(x);

// @supabase/ssr の Cookie（sb-<ref>-auth-token、長いと .0 .1 … に分割、"base64-" + base64url(JSON)）からセッションを取り出す
function sessionFromCookies(cookies) {
  const parts = cookies
    .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
    .sort((a, b) => {
      const n = (c) => Number(c.name.match(/\.(\d+)$/)?.[1] ?? -1);
      return n(a) - n(b);
    });
  if (parts.length === 0) throw new Error("ログイン後の Cookie にセッションがありません");
  let raw = decodeURIComponent(parts.map((c) => c.value).join(""));
  if (raw.startsWith("base64-")) raw = Buffer.from(raw.slice("base64-".length), "base64url").toString("utf8");
  const s = JSON.parse(raw);
  return { access_token: s.access_token, refresh_token: s.refresh_token };
}

async function prepareData(supabase) {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const chars = "ABCDEFGHJKLMNPQRSTUVWYZ0123456789";
  const code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  const { data: field, error: fe } = await supabase
    .from("fields")
    .insert({ name: `E2E計測-${LABEL}-${stamp}`, code, center_lat: 26.5, center_lng: 127.9 })
    .select("id, code, organization_id")
    .single();
  if (fe) throw new Error(`圃場を作れません: ${fe.message}`);
  if (field.organization_id !== "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
    throw new Error(`テスト農園 A 以外の組織（${field.organization_id}）に作られた。中止します`);
  }
  const { data: cultivars, error: ce } = await supabase.from("cultivars").select("id, name").order("name");
  if (ce || !cultivars?.length) throw new Error(`品種を取得できません: ${ce?.message}`);
  const cultivar = cultivars.find((c) => c.name === "ドワーフナムワ") ?? cultivars[0];
  const { data: mat, error: me } = await supabase
    .from("mats")
    .insert({
      field_id: field.id,
      code: `${code}-001`,
      cultivar_id: cultivar.id,
      lat: 26.5,
      lng: 127.9,
      planted_at: "2026-09-15",
      origin_type: "tissue_culture",
    })
    .select("id")
    .single();
  if (me) throw new Error(`株を作れません: ${me.message}`);
  const { data: stem, error: se } = await supabase
    .from("stems")
    .insert({
      mat_id: mat.id,
      generation: 1,
      status: "active",
      started_at: "2026-09-15",
      adopted_at: "2026-09-15",
      initial_leaf_count: 5,
    })
    .select("id")
    .single();
  if (se) throw new Error(`茎を作れません: ${se.message}`);
  // 履歴が空だと実際より軽いので、観測を数件入れておく（実際の茎に近づける）
  const observedBy = (await supabase.auth.getUser()).data.user.id;
  const obs = Array.from({ length: 6 }, (_, i) => ({
    stem_id: stem.id,
    type: "leaves_new",
    value: 1,
    observed_at: new Date(Date.UTC(2026, 8, 20 + i * 3)).toISOString(),
    observed_by: observedBy,
  }));
  const { error: oe } = await supabase.from("observations").insert(obs);
  if (oe) throw new Error(`観測を作れません: ${oe.message}`);
  return { fieldId: field.id, matId: mat.id, stemId: stem.id };
}

// ページ全体を読み込み、主要な要素が見えた時刻（ナビゲーション開始からの ms）と TTFB を返す
async function measurePage(page, url, selector) {
  const response = await page.goto(url, { waitUntil: "commit" });
  const shownAt = await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? performance.now() : false;
    },
    selector,
    { polling: "raf", timeout: 30_000 },
  );
  const shown = await shownAt.jsonValue();
  const nav = await page.evaluate(() => {
    const e = performance.getEntriesByType("navigation")[0];
    return { ttfb: e.responseStart, finalUrl: location.pathname };
  });
  if (!nav.finalUrl.startsWith(new URL(url).pathname)) throw new Error(`${url} が ${nav.finalUrl} に転送された`);
  const h = response?.headers() ?? {};
  return { shown, ttfb: nav.ttfb, vercelId: h["x-vercel-id"] ?? null, serverTiming: h["server-timing"] ?? null };
}

async function measureRecord(page, stemId) {
  // 前回の同期が終わっている（0）のを待つ
  await page.waitForFunction(() => document.querySelector('[data-testid="sync-pending-count"]')?.textContent === "0", null, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => !document.querySelector('[data-testid="leaves-new-1"]')?.disabled, null, { timeout: 30_000 });
  await page.evaluate(() => {
    const w = window;
    w.__perfSeen = false;
    w.__perfDone = null;
    const read = () => document.querySelector('[data-testid="sync-pending-count"]')?.textContent;
    const check = () => {
      const t = read();
      if (t && t !== "0" && t !== "…") w.__perfSeen = true;
      if (w.__perfSeen && t === "0" && w.__perfDone === null) {
        w.__perfDone = performance.now();
        obs.disconnect();
      }
    };
    const obs = new MutationObserver(check);
    obs.observe(document.body, { subtree: true, childList: true, characterData: true });
    w.__perfStart = performance.now();
    document.querySelector('[data-testid="leaves-new-1"]').click();
    check();
  });
  const synced = await (
    await page.waitForFunction(() => window.__perfDone !== null && window.__perfDone - window.__perfStart, null, {
      timeout: 30_000,
    })
  ).jsonValue();
  // 同期のあと SyncStatus が router.refresh() する。その RSC 応答（?_rsc=）が終わるまで（Resource Timing、同じ時計）
  const refreshed = await (
    await page.waitForFunction(
      (id) => {
        const e = performance
          .getEntriesByType("resource")
          .find((r) => r.name.includes(`/stems/${id}`) && r.name.includes("_rsc=") && r.startTime > window.__perfStart && r.responseEnd > 0);
        return e ? { ms: e.responseEnd - window.__perfStart, ttfb: e.responseStart - e.startTime, name: e.name } : false;
      },
      stemId,
      { timeout: 30_000 },
    )
  ).jsonValue();
  return { synced, refreshed: refreshed.ms, refreshTtfb: refreshed.ttfb };
}

async function main() {
  const browser = await chromium.launch();
  // iPhone 相当の幅（chromium で）。Service Worker は実際の利用と同じく有効
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  });
  const page = await context.newPage();

  // ログイン（1 回だけ）
  const loginStart = Date.now();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("メールアドレス").fill(EMAIL);
  await page.getByLabel("パスワード").fill(PASSWORD);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(`${BASE}/`, { timeout: 30_000 });
  await page.getByTestId("organization-name").waitFor();
  const loginMs = Date.now() - loginStart;

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: sessErr } = await supabase.auth.setSession(sessionFromCookies(await context.cookies(BASE)));
  if (sessErr) throw new Error(`セッションを使えません: ${sessErr.message}`);
  const ids = await prepareData(supabase);

  const screens = [
    { key: "home", label: "ホーム", url: `${BASE}/`, selector: '[data-testid="home-field-row"]' },
    { key: "fields", label: "圃場一覧", url: `${BASE}/fields`, selector: '[data-testid="field-row"]' },
    { key: "field", label: "圃場詳細", url: `${BASE}/fields/${ids.fieldId}`, selector: '[data-testid="field-detail-name"]' },
    { key: "mat", label: "株の詳細", url: `${BASE}/mats/${ids.matId}`, selector: '[data-testid="stem-item"]' },
    { key: "stem", label: "茎の画面", url: `${BASE}/stems/${ids.stemId}`, selector: '[data-testid="leaves-new-1"]' },
  ];

  const raw = {};
  for (let i = 0; i < RUNS; i++) {
    for (const s of screens) {
      const r = await measurePage(page, s.url, s.selector);
      (raw[s.key] ??= []).push(r);
      console.log(`${s.label} #${i + 1}: 表示 ${round(r.shown)}ms / TTFB ${round(r.ttfb)}ms (${r.vercelId})`);
    }
  }

  // 画面内のリンクをタップしたときの遷移（クライアント遷移。PWA での普段の操作）: 株の詳細 → 茎の画面
  raw.clientNav = [];
  for (let i = 0; i < RUNS; i++) {
    await page.goto(screens[3].url);
    await page.getByTestId("stem-link").first().waitFor();
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.__navStart = performance.now();
      document.querySelector('[data-testid="stem-link"]').click();
    });
    const ms = await (
      await page.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="leaves-new-1"]');
          return el && el.getBoundingClientRect().height > 0 ? performance.now() - window.__navStart : false;
        },
        null,
        { polling: "raf", timeout: 30_000 },
      )
    ).jsonValue();
    raw.clientNav.push({ shown: ms });
    console.log(`株→茎（タップ） #${i + 1}: ${round(ms)}ms`);
  }
  if (process.env.PERF_DEBUG_HEADERS) {
    const res = await page.goto(screens[0].url);
    console.log(res.headers());
  }

  await page.goto(screens[4].url);
  await page.getByTestId("leaves-new-1").waitFor();
  raw.record = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await measureRecord(page, ids.stemId);
    raw.record.push(r);
    console.log(`+1 #${i + 1}: 同期 ${round(r.synced)}ms / refresh 応答まで ${round(r.refreshed)}ms（refresh の TTFB ${round(r.refreshTtfb)}ms）`);
  }

  await browser.close();

  const summary = screens.map((s) => ({
    screen: s.label,
    shownMedianMs: round(median(raw[s.key].map((r) => r.shown))),
    ttfbMedianMs: round(median(raw[s.key].map((r) => r.ttfb))),
  }));
  summary.push({ screen: "株→茎（タップでクライアント遷移）", shownMedianMs: round(median(raw.clientNav.map((r) => r.shown))) });
  summary.push({
    screen: "+1 の記録",
    syncedMedianMs: round(median(raw.record.map((r) => r.synced))),
    refreshedMedianMs: round(median(raw.record.map((r) => r.refreshed))),
  });
  const vercelIds = [...new Set(Object.values(raw).flat().filter((r) => r.vercelId).map((r) => r.vercelId.split("::").slice(0, -1).join("::")))];

  const out = { label: LABEL, base: BASE, runs: RUNS, at: new Date().toISOString(), loginMs, vercelRegions: vercelIds, ids, summary, raw };
  const dir = path.join(ROOT, "scripts/perf/results");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${LABEL}-${out.at.replace(/\D/g, "").slice(0, 14)}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));

  console.log(`\nリージョン（x-vercel-id の接頭）: ${vercelIds.join(", ")}`);
  console.log(`ログイン: ${loginMs}ms\n`);
  console.log("| 画面 | 表示（中央値） | TTFB（中央値） |");
  console.log("|---|---:|---:|");
  for (const s of summary.slice(0, -1)) console.log(`| ${s.screen} | ${s.shownMedianMs} ms | ${s.ttfbMedianMs ?? "—"} ms |`);
  const rec = summary.at(-1);
  console.log(`| +1 → 未同期 0 | ${rec.syncedMedianMs} ms | — |`);
  console.log(`| +1 → refresh 応答 | ${rec.refreshedMedianMs} ms | — |`);
  console.log(`\n${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
