import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { THEME_COLOR } from "./manifest";
import { RegisterServiceWorker } from "./register-sw";
import { SyncStatus } from "./sync-status";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "バナナ生育記録",
  description: "バナナの生育記録と収穫予測",
  // PWA（1-10）: manifest とホーム画面追加（iOS）の設定
  manifest: "/manifest.webmanifest",
  // appleWebApp.capable は Next.js 16 では標準の mobile-web-app-capable（iOS 17.4 以降が対応）を出す。
  // それより古い iOS のために apple-mobile-web-app-capable も明示する
  appleWebApp: { capable: true, statusBarStyle: "default", title: "バナナ記録" },
  other: { "apple-mobile-web-app-capable": "yes" },
  icons: { apple: { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" } },
};

// themeColor は Next.js 16 では metadata ではなく viewport に置く
export const viewport: Viewport = {
  themeColor: THEME_COLOR,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Service Worker の登録（アプリの殻のキャッシュ。データ同期はしない） */}
        <RegisterServiceWorker />
        {/* 全画面のヘッダ: 未同期件数（1-9）。同期のトリガーもここで登録する */}
        <SyncStatus />
        {children}
      </body>
    </html>
  );
}
