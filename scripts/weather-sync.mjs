// 気温の取り込み（3-1）を手動で走らせる: /api/cron/weather を Authorization: Bearer ${CRON_SECRET} で叩く。
// CRON_SECRET は .env.local から読む（Vercel Cron と同じ値）。サーバー側に SUPABASE_SERVICE_ROLE_KEY が必要。
//
//   npm run weather:sync                          # http://127.0.0.1:3000（npm run dev を先に起動）の全圃場
//   npm run weather:sync -- --field <圃場の id>     # 1 圃場だけ
//   npm run weather:sync -- --url https://<本番のドメイン>   # 本番（Cloudflare Access の内側なら通らないことがある）
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(root, ".env.local"), quiet: true });

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("CRON_SECRET が .env.local にありません");
  process.exit(1);
}
const base = (arg("url") ?? process.env.WEATHER_SYNC_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const field = arg("field");
const url = `${base}/api/cron/weather${field ? `?fieldId=${encodeURIComponent(field)}` : ""}`;

console.log(`GET ${url}`);
const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = text;
}
console.log(`HTTP ${res.status}`);
if (body && typeof body === "object" && Array.isArray(body.results)) {
  for (const r of body.results) {
    const errors = r.errors.length ? ` エラー: ${r.errors.join(" / ")}` : "";
    console.log(`  ${r.fieldId}: ${r.days}日分 / 時間別 ${r.hours}件${r.timedOut ? "（時間切れ。残りは次回）" : ""}${errors}`);
  }
  console.log(`処理 ${body.processed} 圃場、次回に回した ${body.skipped} 圃場、${body.ms} ms`);
} else {
  console.log(body);
}
process.exit(res.ok ? 0 : 1);
