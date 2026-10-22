"use client";

import { useEffect } from "react";

// Service Worker（public/sw.js）を登録する（1-10）。開発・本番とも登録する。
// SW はアプリの殻（HTML / JS / CSS）だけをキャッシュし、データの同期は Dexie の outbox（1-9）が担当する。
// updateViaCache: "none" で sw.js 自体を HTTP キャッシュから読まず、常にサーバーに更新を問い合わせる。
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch((e) => {
      console.warn("Service Worker を登録できませんでした", e);
    });
  }, []);
  return null;
}
