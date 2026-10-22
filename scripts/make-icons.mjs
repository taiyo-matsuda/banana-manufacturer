// PWA のアイコンを SVG から生成する（1-10）。
//   node scripts/make-icons.mjs
// 生成物（public/icons/*.png、public/apple-touch-icon.png）はコミットする（ビルド時には実行しない）。
// 図柄は単色の背景に黄色いバナナ 1 本。maskable は安全領域（中央 80%）に収まるよう余白を広くとる。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BG = "#2f6f3e"; // manifest の theme_color / background_color と合わせる
const BANANA = "#f6c945";
const TIP = "#6b4b16";

// pad: バナナを収める領域の余白（0〜0.5）。maskable は 0.2 にして端が切られても欠けないようにする
function svg(size, pad) {
  const inner = size * (1 - pad * 2);
  const offset = size * pad;
  // 100x100 の座標系にバナナ（三日月形）を描き、inner に拡大する
  const scale = inner / 100;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">
    <path d="M18 28 C 14 60, 42 90, 80 86 C 86 85, 88 80, 84 78 C 52 72, 34 52, 30 24 C 29 18, 20 20, 18 28 Z"
          fill="${BANANA}" stroke="#c99a1e" stroke-width="2" stroke-linejoin="round"/>
    <path d="M22 20 L 32 18 L 33 24 L 24 27 Z" fill="${TIP}"/>
    <path d="M80 86 L 90 88 L 88 80 Z" fill="${TIP}"/>
  </g>
</svg>`;
}

async function write(file, size, pad) {
  const png = await sharp(Buffer.from(svg(size, pad))).png().toBuffer();
  writeFileSync(file, png);
  console.log(`${file} (${size}x${size}, ${png.length} bytes)`);
}

const iconsDir = join(root, "public", "icons");
mkdirSync(iconsDir, { recursive: true });
// 元の SVG も置いておく（図柄を変えるときの参照用）
writeFileSync(join(iconsDir, "icon.svg"), svg(512, 0.1));

await write(join(iconsDir, "icon-192.png"), 192, 0.1);
await write(join(iconsDir, "icon-512.png"), 512, 0.1);
await write(join(iconsDir, "icon-512-maskable.png"), 512, 0.2);
await write(join(root, "public", "apple-touch-icon.png"), 180, 0.1);
