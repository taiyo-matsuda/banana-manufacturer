"use client";

import { useEffect } from "react";

// Service Worker（public/sw.js）を登録する（1-10）。開発・本番とも登録する。
// SW はアプリの殻（HTML / JS / CSS）だけをキャッシュし、データの同期は Dexie の outbox（1-9）が担当する。
// updateViaCache: "none" で sw.js 自体を HTTP キャッシュから読まず、常にサーバーに更新を問い合わせる。
// 2-9: SW が有効になったら、このページが読み込んだ /_next/static/ の JS・CSS の URL を SW に送ってキャッシュさせる
// （SW の制御が始まる前に読んだもの・動的に読んだ chunk も、オフラインの殻を圏外で開くときに使えるように）。
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((e) => {
      console.warn("Service Worker を登録できませんでした", e);
    });
    let cancelled = false;
    void navigator.serviceWorker.ready.then((reg) => {
      if (cancelled || !reg.active) return;
      const urls = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((u) => u.startsWith(`${location.origin}/_next/static/`));
      if (urls.length > 0) reg.active.postMessage({ type: "cache-assets", urls });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
