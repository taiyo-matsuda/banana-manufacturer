import type { Metadata } from "next";
import { OfflineShell } from "./offline-shell";

// オフラインの殻（2-9、offline-sync.md 5.5）。Service Worker（public/sw.js）が install でプリキャッシュし、
// 対象の URL へのナビゲーションで「ネットワークに届かず、ナビゲーションのキャッシュにも無い」ときにこの HTML を返す。
// サーバーでは何も読まない（静的に描画する。認証のリダイレクトもかけない: src/lib/auth/redirect.ts の PUBLIC_PATHS）。
// 中身はすべてクライアントで、URL と端末のキャッシュ（Dexie）から組み立てる（offline-shell.tsx）。
export const metadata: Metadata = { title: "バナナ生育記録（オフライン）" };

export default function OfflineShellPage() {
  return <OfflineShell />;
}
