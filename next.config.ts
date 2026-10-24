import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // E2E は 127.0.0.1 で接続する。開発サーバーが localhost 起点で起動していても
  // 開発用リソース（/_next/hmr など）を拒否しないようにする（拒否されると地図ページが読み込み中のまま止まる）
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  // 開発用の画面左下のインジケーターは下部タブ（UX-1）の「ホーム」に重なり、E2E のタップを遮るので出さない
  // （コンパイル・実行時のエラー表示は従来どおり出る）
  devIndicators: false,
  // Service Worker は HTTP キャッシュに長く残さない（更新が即座に届くように。register-sw.tsx の updateViaCache: "none" と併用）
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
