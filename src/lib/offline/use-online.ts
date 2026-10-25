"use client";

import { useSyncExternalStore } from "react";
import { isOnline } from "./sync-client";

// ブラウザがオンラインか（online / offline イベントで更新）。SSR とハイドレーション中はオンライン扱い。
// オンライン前提の操作（株分け 2-2 など）のボタンの出し分けに使う
function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true);
}
