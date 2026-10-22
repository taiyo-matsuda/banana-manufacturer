// MapLibre GL JS v6 は Web Worker を `import.meta.url` の隣から読むが、バンドラ（Turbopack）経由では
// その場所に worker ファイルがないので読み込みに失敗する。worker のバンドルを public/ に置き、
// アプリ側は setWorkerUrl("/maplibre/maplibre-gl-worker.mjs") で明示する。
// `npm run dev` / `npm run build` の前に自動で実行される（predev / prebuild）。コピー先は git に入れない。
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "maplibre-gl", "dist", "maplibre-gl-worker.mjs");
const destDir = join(root, "public", "maplibre");
const dest = join(destDir, "maplibre-gl-worker.mjs");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`copied maplibre worker (${statSync(dest).size} bytes) -> public/maplibre/maplibre-gl-worker.mjs`);
