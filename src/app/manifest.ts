import type { MetadataRoute } from "next";

// PWA の manifest（1-10）。/manifest.webmanifest で配信される。
// theme_color / background_color は scripts/make-icons.mjs の背景色と layout.tsx の viewport.themeColor に合わせる。
export const THEME_COLOR = "#2f6f3e";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "バナナ生育記録",
    short_name: "バナナ記録",
    description: "バナナの生育記録と収穫予測",
    lang: "ja",
    start_url: "/",
    display: "standalone",
    theme_color: THEME_COLOR,
    background_color: THEME_COLOR,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
