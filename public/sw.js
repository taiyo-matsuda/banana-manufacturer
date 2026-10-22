// Service Worker（1-10 PWA）。アプリの殻（HTML / JS / CSS）だけをキャッシュする。
// データの同期は Dexie の outbox（src/lib/offline/、1-9）が担当し、ここでは一切しない（offline-sync.md 6 章）。
//
// 方針:
// - 自オリジン以外（Supabase、Google Fonts など）には触らない（fetch イベントで早期 return）
// - GET 以外（Server Action の POST など）には触らない
// - /_next/static/（ハッシュ付きで不変）はキャッシュ優先
// - ナビゲーション（HTML の GET）はネットワーク優先 → 失敗したらキャッシュ → キャッシュもなければ /offline
//   成功した応答（200）はキャッシュに入れる（オンラインで開いた茎の画面が圏外でも開く）
// - RSC のペイロード（RSC / Next-Router-Prefetch ヘッダ付き）、/_next/image、/api/、開発用（/_next/hmr 等）はネットワークのみ
// - 将来の検討: 地図タイル（cyberjapandata.gsi.go.jp）のキャッシュ。1-10 ではしない（別オリジンなので上の規則で素通り）
//
// 更新: 中身を変えたら VERSION を上げる。activate で古いキャッシュを消し、skipWaiting / clients.claim で即時に有効化する。

const VERSION = "v1";
const SHELL_CACHE = `shell-${VERSION}`; // ナビゲーション（HTML）と /offline
const STATIC_CACHE = `static-${VERSION}`; // /_next/static/
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // /offline をプリキャッシュ。認証のリダイレクトはかからない（redirect.ts の PUBLIC_PATHS）
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
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
