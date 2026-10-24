"use client";

import { useEffect, useSyncExternalStore } from "react";
import { DEVICE_OWNER_KEY, shouldClearForUser, USER_SCOPED_KEYS } from "@/lib/device-prefs";

// 端末の localStorage の読み書き（UX-1）。プライベートモードなどで使えなくても画面は動かす（例外は握りつぶす）。
// 書いたら同じタブの購読者に知らせる（storage イベントは他のタブにしか飛ばないため）。
const CHANGE_EVENT = "device-store-change";

export function readItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeItem(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch (err) {
    console.warn("localStorage に保存できません", err);
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

// ログアウト時: このユーザーの情報（最近開いた株・直近の圃場）と持ち主を消す
export function clearDeviceStore() {
  for (const key of [...USER_SCOPED_KEYS, DEVICE_OWNER_KEY]) writeItem(key, null);
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

// key の値を parse した結果を購読する。生の文字列が変わらない限り同じ参照を返す（useSyncExternalStore の要件）
const cache = new Map<string, { raw: string | null; value: unknown }>();
export function useStoredValue<T>(key: string, parse: (raw: string | null) => T, serverValue: T): T {
  return useSyncExternalStore(
    subscribe,
    () => {
      const raw = readItem(key);
      const hit = cache.get(key);
      if (hit && hit.raw === raw) return hit.value as T;
      const value = parse(raw);
      cache.set(key, { raw, value });
      return value;
    },
    () => serverValue,
  );
}

// ログイン中のユーザーを端末に知らせる。前に残っていた情報が別のユーザーのものなら消す。画面には何も出さない
export function DeviceOwner({ userId }: { userId: string }) {
  useEffect(() => {
    if (!shouldClearForUser(readItem(DEVICE_OWNER_KEY), userId)) return;
    for (const key of USER_SCOPED_KEYS) writeItem(key, null);
    writeItem(DEVICE_OWNER_KEY, userId);
  }, [userId]);
  return null;
}
