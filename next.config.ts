import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // E2E は 127.0.0.1 で接続する。開発サーバーが localhost 起点で起動していても
  // 開発用リソース（/_next/hmr など）を拒否しないようにする（拒否されると地図ページが読み込み中のまま止まる）
  allowedDevOrigins: ["127.0.0.1", "localhost"],
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
