// Service Worker（1-10 PWA、2-9 オフラインの殻）。アプリの殻（HTML / JS / CSS）だけをキャッシュする。
// データの同期は Dexie の outbox と読み取りのキャッシュ（src/lib/offline/、src/lib/cache/）が担当し、ここでは一切しない（offline-sync.md 6 章）。
//
// 方針:
// - 自オリジン以外（Supabase、Google Fonts など）には触らない（fetch イベントで早期 return）
// - GET 以外（Server Action の POST など）には触らない
// - /_next/static/（ハッシュ付きで不変）はキャッシュ優先
// - ナビゲーション（HTML の GET）はネットワーク優先 → 失敗したらナビゲーションのキャッシュ → それも無ければ
//   殻の対象の URL（SHELL_ROUTES）ならオフラインの殻（/offline-shell、2-9）、それ以外は /offline
//   成功した応答（200）はキャッシュに入れる（オンラインで開いた画面が圏外でも開く）
// - RSC のペイロード（RSC / Next-Router-Prefetch ヘッダ付き）、/_next/image、/api/、開発用（/_next/hmr 等）はネットワークのみ
// - install で /offline と /offline-shell、その HTML が読む /_next/static/ の JS・CSS をプリキャッシュする
//   （殻は一度も開いていない端末でも圏外で動く必要がある）
// - ログアウト時はページ側（src/lib/offline/logout.ts）がナビゲーションのキャッシュ（shell-* の HTML）を消す。
//   /offline と /offline-shell は残す（別のユーザーの画面を圏外で見せないため。殻はデータを持たない）
// - 将来の検討: 地図タイル（cyberjapandata.gsi.go.jp）のキャッシュ。しない（別オリジンなので上の規則で素通り）
//
// 更新: 中身を変えたら VERSION を上げる。activate で古いキャッシュを消し、skipWaiting / clients.claim で即時に有効化する。

const VERSION = "v2";
const SHELL_CACHE = `shell-${VERSION}`; // ナビゲーション（HTML）と /offline・/offline-shell
const STATIC_CACHE = `static-${VERSION}`; // /_next/static/
const OFFLINE_URL = "/offline";
const OFFLINE_SHELL_URL = "/offline-shell";

// オフラインの殻が描く画面（src/lib/cache/shell-route.ts の matchShellRoute と同じ。片方を変えたら両方を変える）
const ID = "[0-9A-Za-z-]+";
const SHELL_ROUTES = [
  /^\/$/,
  new RegExp(`^/fields/(?!new$)${ID}/?$`),
  new RegExp(`^/fields/${ID}/map/?$`),
  new RegExp(`^/mats/${ID}/?$`),
  new RegExp(`^/stems/${ID}/?$`),
  new RegExp(`^/stems/${ID}/history/?$`),
];

function isShellRoute(pathname) {
  return SHELL_ROUTES.some((re) => re.test(pathname));
}

// HTML が読む /_next/static/ の URL（script の src、link の href）
function staticAssetsOf(html) {
  const urls = new Set();
  for (const m of html.matchAll(/["'(](\/_next\/static\/[^"'()\s\\]+)/g)) urls.add(m[1]);
  return [...urls];
}

async function precachePage(url) {
  const shell = await caches.open(SHELL_CACHE);
  const response = await fetch(new Request(url, { cache: "reload" }));
  if (!response.ok) throw new Error(`${url} を取得できません（${response.status}）`);
  await shell.put(url, response.clone());
  const html = await response.text();
  const statics = await caches.open(STATIC_CACHE);
  // 1 つ失敗しても install 全体は落とさない（開いたときに cacheFirst で入る）
  await Promise.all(
    staticAssetsOf(html).map(async (asset) => {
      try {
        if (await statics.match(asset)) return;
        const r = await fetch(asset);
        if (r.ok) await statics.put(asset, r);
      } catch {
        // 何もしない
      }
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      // 認証のリダイレクトはかからない（redirect.ts の PUBLIC_PATHS）
      await Promise.all([precachePage(OFFLINE_URL), precachePage(OFFLINE_SHELL_URL)]);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n !== SHELL_CACHE && n !== STATIC_CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

// ページが読み込んだ /_next/static/ の JS・CSS（SW の制御が始まる前に読んだもの、動的に読んだ chunk を含む）を
// キャッシュに入れる（src/app/register-sw.tsx が送る）。殻を圏外で開いたときに chunk が欠けてハイドレーションが止まらないように
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "cache-assets" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      const statics = await caches.open(STATIC_CACHE);
      for (const raw of data.urls.slice(0, 500)) {
        try {
          const url = new URL(raw, self.location.origin);
          if (url.origin !== self.location.origin || !url.pathname.startsWith("/_next/static/")) continue;
          if (await statics.match(url.pathname + url.search)) continue;
          const r = await fetch(url.pathname + url.search);
          if (r.ok) await statics.put(url.pathname + url.search, r);
        } catch {
          // 何もしない（次の読み込みで cacheFirst が入れる）
        }
      }
    })(),
  );
});

function isNavigation(request) {
  if (request.mode === "navigate") return true;
  const accept = request.headers.get("accept") || "";
  return request.destination === "document" || accept.includes("text/html");
}

function isRscRequest(request) {
  return request.headers.has("RSC") || request.headers.has("Next-Router-Prefetch");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Supabase、フォント、地図タイルなどには触らない

  const path = url.pathname;
  if (path.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }
  if (
    path.startsWith("/_next/") || // /_next/image、/_next/hmr、開発用のリソース
    path.startsWith("/api/") ||
    path === "/sw.js" ||
    isRscRequest(request) // RSC のペイロード（クライアントナビゲーション・プリフェッチ）はネットワークのみ
  ) {
    return;
  }
  if (isNavigation(request)) {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  // それ以外の同一オリジン GET（アイコン、manifest、maplibre の worker など）はネットワーク → 失敗したらキャッシュ
  event.respondWith(networkFirst(request, STATIC_CACHE));
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw e;
  }
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    // 200 の HTML だけキャッシュする（リダイレクト（/login への転送）やエラーは入れない）
    if (response.ok && !response.redirected) {
      const type = response.headers.get("content-type") || "";
      if (type.includes("text/html")) await cache.put(stripSearch(request), response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(stripSearch(request));
    if (cached) return cached;
    // 2-9: 一度同期した圃場・株・茎の画面は、殻が端末のキャッシュから描く（URL はそのまま）
    if (isShellRoute(new URL(request.url).pathname)) {
      const shell = await cache.match(OFFLINE_SHELL_URL);
      if (shell) return shell;
    }
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response("圏外です", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}

// キャッシュのキーからクエリを除く（同じ画面を同じキーで引けるように）
function stripSearch(request) {
  const url = new URL(request.url);
  if (!url.search) return request;
  url.search = "";
  return new Request(url.toString(), { method: "GET", headers: request.headers });
}
