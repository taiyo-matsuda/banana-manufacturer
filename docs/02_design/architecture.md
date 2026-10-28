# 設計: 全体構成

最終更新: 2026-10-21　要件: `../01_requirements.md`

---

## 1. 構成

```
iPhone / PC のブラウザ
  └ Next.js (PWA)  ── Supabase JS ──▶ Supabase
       │  IndexedDB (Dexie)              ├ PostgreSQL (RLS)
       │  同期キュー                      ├ Auth
       │  Service Worker                 └ Storage (写真)
       └ MapLibre ── 地理院タイル（空中写真）

Vercel Cron → Next.js の Route Handler（/api/cron/weather、3-1）
  └ Open-Meteo から気象を取得 → weather_hourly / weather_daily
  └ 推定・提案の再計算
```

| 層 | 採用 | 理由 |
|---|---|---|
| フロント | Next.js（App Router、TypeScript、Tailwind）、PWA | iPhone でホーム画面に追加して使える。ストア不要。PC でも同じ画面 |
| バックエンド | Supabase（PostgreSQL、Auth、Storage、RLS） | 圃場→株→茎のような関係の深いデータと集計に PostgreSQL が向く。RLS で農家ごとの分離が標準で作れる |
| オフライン | IndexedDB（Dexie）＋ 同期キュー | 圏外での記録。詳細は `offline-sync.md` |
| 地図 | MapLibre GL JS ＋ 地理院タイル（空中写真） | 無料、出典表示で利用可。点が緯度経度を持つ。将来ドローンのオルソ画像を重ねられる |
| 気象 | Open-Meteo | 無料、時間別、過去・予報。圃場の座標で取得できる |
| 予測ロジック | `src/lib/` の純粋 TypeScript（単体テスト付き） | UI と分離。将来 Python に移す場合も仕様が明確 |
| ホスティング | Vercel または Cloudflare Pages ＋ Cloudflare Access | サイト全体を許可メールアドレスだけに制限できる |

## 2. 認証とアクセス制限

- **Supabase Auth**（メール＋パスワード）。セルフ Sign Up は Supabase 側で無効化し、アカウントは管理者がダッシュボードから作る。アプリに Sign Up 画面は作らない。
- **Cloudflare Access** でサイト全体を保護する。許可メールアドレス以外にはログイン画面すら表示されない。
- ユーザーは `profiles` で組織に紐づく。`current_org()` 関数がログイン中ユーザーの組織を返し、すべての RLS ポリシーがこれを使う。
- 将来: 招待制（管理者が招待メールを送る）、スタッフ権限（`profiles.role`）。
- **service_role（Secret key）はアプリに置かない。例外は気温の日次取り込み（3-1）の Cron の Route Handler `src/app/api/cron/weather/route.ts` だけ**。全組織の圃場を処理するため RLS を通らないクライアントが要る。
  - キーはサーバー側の環境変数 `SUPABASE_SERVICE_ROLE_KEY` からだけ読む（`NEXT_PUBLIC_` を付けない。ブラウザのバンドルに入らない）。読むのは `import "server-only"` を付けた `src/lib/supabase/service-role.ts` だけで、これを import するのは Cron の Route Handler だけ（画面・Server Action・クライアントのコードからは import しない）
  - Route Handler の認証は `Authorization: Bearer ${CRON_SECRET}`（Vercel Cron の標準）。`CRON_SECRET` が未設定・ヘッダが無い・違うなら 401。proxy は `/api/cron/weather` を /login に転送しない（`src/lib/auth/redirect.ts` の PUBLIC_PATHS。Cron は Cookie を持たない）
  - 圃場の登録時・代表点の変更時（Server Action の `after()`）と、圃場の詳細の「気温を今すぐ取り込む」は、ログイン中のユーザーのクライアント（RLS で自組織の圃場だけ）で取り込む。service_role は使わない
  - 収穫予測日の再計算（3-3、prediction.md 2 章）も、Cron の中（取り込みの後）だけ service_role。出蕾・被害の同期の後に同期ワーカーが呼ぶ Route Handler `POST /api/predictions/recompute`、Server Action（訂正・圃場や株の被害・予測の設定・今すぐ取り込む）、茎の画面はログイン中のユーザーのクライアント（RLS で自組織の茎だけ）。3-4 の提案の評価（`src/lib/derived.ts`）も同じ入口・同じクライアントで、収穫予測日の再計算の後に走る（3-5: 施肥の一括入力・株の撤去の Server Action は提案だけを評価し直す）。`/api/predictions/recompute` は PUBLIC_PATHS に入れない（未ログインは /login へ。Route Handler も getUser で 401）

## 3. データ分離（複数農家対応）

- 全テーブルに `organization_id` を持つ（意図的な非正規化）。詳細は `data-model.md`。
- RLS は全テーブルで `organization_id = current_org()` の1条件。
- 品種マスタ（`cultivars`）だけは全組織で共有（読み取りのみ）。

## 4. 写真

- ファイルは Supabase Storage のバケット `photos` に置く。パスは `{organization_id}/{target_type}/{target_id}/{photo_id}.jpg`。
- Storage のポリシーも `organization_id` のプレフィックスで制限する。
- DB の `photos` 行には参照と撮影情報だけを持つ。
- アップロード前に端末側で長辺 2048px 程度に縮小する（通信量と Storage 容量のため。原寸が必要になったら設定で変えられるようにする）。

## 5. 気象の取り込み

- 1日1回、圃場ごとに Open-Meteo から時間別データ（気温・降水・風速）を取得して `weather_hourly` に入れ、`weather_daily` に集計する。保存の約束（`api` 列で暫定値／確定値を区別し upsert で上書き、補正の記録）は `data-model.md` の weather_hourly / weather_daily。
- 実行は Vercel Cron から Route Handler `/api/cron/weather` を GET で叩く（`vercel.json` の `crons`、`0 20 * * *` = 日本時間 5:00。Hobby は 1 日 1 回まで）。手動は `npm run weather:sync`（`.env.local` の `CRON_SECRET` で同じエンドポイントを叩く。`--field <id>` で 1 圃場、`--url` で叩く先）。
- API: 予報 API（`https://api.open-meteo.com/v1/forecast`、`past_days=7`）で直近 7 日、過去 API（`https://archive-api.open-meteo.com/v1/archive`）で 5 日より前の確定値。`hourly=temperature_2m,precipitation,wind_speed_10m`、`wind_speed_unit=ms`、`timezone=Asia/Tokyo`。API キー不要。取得は `src/lib/weather/`（fetch を注入できる形）。
- 取り込みのたびに、圃場の「埋めるべき開始日（登録日と最も古い茎の `started_at` の早い方）〜 昨日」と平年値の材料（過去 10 年分、日次だけ）で確定値のない日を探し、まとめて過去 API で取る。API が失敗した日は次回の対象に残る（欠けた日が埋まる）。
- 1 回の Cron は約 50 秒で打ち切り（`maxDuration = 60`）、残りは次回に続きから。前回の実行が古い圃場から処理する。過去 API は新しい日から取る。
- 各圃場の取り込みの後、その圃場の出蕾済みの茎の収穫予測日を再計算して `estimates` に追記する（3-3。前回と同じなら追記しない）。応答の `predictions` に圃場ごとの件数（stems / inserted / unchanged / errors）。
- 圃場の登録・代表点の変更: Server Action が `after()` で、応答を返した後にその圃場の取り込みを始める（登録の応答を遅くしない）。ここでは埋めるべき期間と直近 7 日だけ取り、10 年分の平年値の材料は次の Cron（または圃場の詳細の「気温を今すぐ取り込む」）で取る。代表点が変わっていたら前の地点の値を消して取り直す。
- 取り込みの記録（最終実行・件数・最後のエラー）は `weather_sync_status`。圃場の詳細に「気温: 最終取得 ◯月◯日 ◯:◯◯（◯日分）」、失敗の理由、未取得なら「取り込み待ち」。
- `fields.temperature_offset_c` を加算してから保存する（加えた値は各行の `temperature_offset_c` に残る）。
- E2E: 開発サーバーを `WEATHER_MOCK=1` で起動すると Open-Meteo の代わりにモック（`src/lib/weather/mock.ts`）を使う。`NODE_ENV=production`・Vercel では環境変数があっても効かない（`src/lib/weather/server.ts`）。失敗は Cookie / ヘッダ `e2e-weather-fault`（モックのときだけ読む）で起こす。

## 6. 推定と提案の計算

- 推定（収穫予測日、果房重量）は、関係するイベントが記録されたとき、および気象が更新された後の日次バッチで再計算する。
- 計算は `src/lib/prediction/` の純粋関数。入力は DB から読み、結果は `estimates` に追記する（上書きしない）。
- 提案（`recommendations`）も同じタイミングでルールから生成する。同じ対象・同じ種類で `open` のものがあれば作らない。

## 7. 環境

| 環境 | 用途 |
|---|---|
| ローカル開発 | `npm run dev` ＋ **手元の Supabase**（Supabase CLI。`npx supabase start`、API は `http://127.0.0.1:54321`。Docker Desktop が必要）。`.env.local` は手元の値（`npx supabase status`）。スキーマは `supabase/migrations/`、テスト農園 A / B とそのユーザーは `supabase/seed.sql`（`npx supabase db reset` で流し直す）。手元の Auth も Sign Up は無効（`config.toml`）。本番のデータを見たいときは Vercel の本番で見る |
| E2E テスト | Playwright。**手元の Supabase** のテスト用組織 2 つ（テスト農園 A / B。組織は `0003_test_orgs.sql`、auth ユーザー・`profiles` は `seed.sql`）。A をほぼ全テストで使い、B は「A のデータが見えない」という組織分離の検証にだけ使う。本人のアカウントは E2E に使わない。**本番（リモート）の Supabase には流さない**（無料枠を使わないため）: `playwright.config.ts` と `e2e/global-setup.ts` が `NEXT_PUBLIC_SUPABASE_URL` のホストを確かめ、`127.0.0.1` / `localhost` でなければ通信の前に止まる。手元の API（`/auth/v1/health`）に繋がらなければ「`npx supabase start` してください」で止まる。`e2e/local-only.spec.ts` が、主要な画面の巡回中にブラウザから `*.supabase.co` への通信が 0 件で、Supabase の API への通信が 127.0.0.1 だけであることを検証する |
| E2E の安定化 | **ログインは共有する。** setup プロジェクト（`e2e/auth.setup.ts`）がテスト農園 A / B に 1 回ずつ UI ログインし、Cookie（`storageState`）と supabase-js 用のセッションを `e2e/.auth/`（gitignore）に保存。iphone / desktop は `dependencies: ["setup"]` で A の状態から始まり、B で見るテストは `test.use({ storageState: AUTH_STATE_B })`、未ログインの検証は `noSession`。ログイン画面を実際に通すのは auth.spec の 2 件だけ。DB を直接読み書きするテストは `supabaseAsA()` / `supabaseAsB()`（保存セッションを使い、サインインしない）。Supabase Auth のサインインは IP ごとにレート制限があり、テストごとにログインすると 1 回の実行で上限を超える（手元の Supabase では `config.toml` の `[auth.rate_limit]` で緩めてあるが、ログインの共有は続ける）。**その他:** `workers` は 2 に固定。expect と操作のタイムアウトは全体で 15 秒（リモートの Supabase で流していた頃は、遅い時間帯に全テストが 2〜3 倍遅くなり既定の 5 秒が切れた）。登録・確定（Server Action）直後の検証は `ACTION_TIMEOUT`（15 秒）で待つ（1 回の登録で Supabase への往復 5 回が直列に走る）。setup の最後に `/login`、`/`、`/fields`、圃場の詳細、地図を 1 回ずつ開いてウォームアップする（開発サーバーは実行ごとに起動され、ルートの初回アクセスで Turbopack のコンパイルが走るため）。setup の最後に E2E が作った圃場・株・茎と、その観測・イベント・写真（名前が `E2E` で始まる圃場に紐づくもの）を消す（溜まると一覧が数百行になり refresh の応答が数百 KB になる）。観測・イベントは追記のみでアプリの権限では消せないため、掃除は組織名で制限した security definer の DB 関数 `e2e_cleanup_fields`（`0006_e2e_cleanup.sql`）を RPC で 1 回呼ぶ。開発サーバーと baseURL は `127.0.0.1`（IPv4）に固定する（`localhost` は IPv6 の [::1] で繋がる）。Windows では `e2e/global-setup.ts` が開発サーバー（:3000）向けの TIME_WAIT ソケットを数え、6,000 を超えていれば解放を待つ。通常は 1 回の実行で残るのは数百個で、この待ちに入ることはない。TIME_WAIT が解放されず約 9,000 個のまま詰まり、IPv6 の動的ポート（16,384 個）を使い切って Supabase への fetch まで `fetch failed` になった異常が一度あり、PC の再起動で解消した。地図画面（`/fields/[id]/map`）は Client Component で、開発サーバーでは初回表示に Turbopack のコンパイルと MapLibre の読み込みがかかるため、表示待ちも `ACTION_TIMEOUT` |
| 本番 | Vercel ＋ 本番 Supabase（リモート）＋ Cloudflare Access。手順は `docs/04_ops/deploy.md`。新しいマイグレーションは手元で確かめ、reviewer の PASS 後にオーケストレーターがユーザーと `npx supabase db push` で適用する（タスク用のセッションはリモートに push しない） |

環境変数（`.env.local`、コミットしない。雛形は `.env.example`。開発と E2E は手元の Supabase の値。本番の値は Vercel の環境変数だけに置く）:
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY   # Publishable key（公開用）。service_role / Secret key は絶対に置かない
E2E_EMAIL / E2E_PASSWORD        # テスト農園 A
E2E_B_EMAIL / E2E_B_PASSWORD    # テスト農園 B
CRON_SECRET                     # 気温の日次取り込み（3-1）の Cron のシークレット。Vercel の環境変数にも同じ値
SUPABASE_SERVICE_ROLE_KEY       # service_role。Cron の Route Handler だけが使う（2 章の例外）。NEXT_PUBLIC_ を付けない
```

- `SUPABASE_SERVICE_ROLE_KEY` と `CRON_SECRET` は Vercel の環境変数（Production）にも設定する。service_role は気温の日次取り込みの Cron の Route Handler だけの例外（2 章）。
- E2E: `playwright.config.ts` が開発サーバーを `WEATHER_MOCK=1` で起動し、`CRON_SECRET` が `.env.local` に無ければ E2E 用の値を渡す。`SUPABASE_SERVICE_ROLE_KEY` は手元の Supabase の service_role（`npx supabase status`）を `.env.local` に置く（無ければ global-setup が止める）。Cron の Route Handler を叩く E2E（weather.spec の Cron の 2 回実行）も手元で走る。E2E の Cron は `?fieldId=` でテスト用の圃場だけを処理する（他の圃場の取り込みで遅くしないため）。
- 手元の `.env.local` の service_role は手元の Supabase の開発用の鍵で、本番の鍵ではない。本番の service_role は Vercel の環境変数にだけ置く。

## 8. ディレクトリ

```
src/
  app/               画面（App Router）
  components/        UI 部品
  lib/
    supabase/        クライアント（ブラウザ用・サーバー用）、型
    db/              IndexedDB（Dexie）のスキーマと同期キュー
    leaves.ts        葉数の計算
    gdd.ts           積算温度
    prediction/      収穫予測、果房重量
    recommendations/ 提案ルール
    geo.ts           株の格子生成、距離計算
supabase/
  migrations/        スキーマ
e2e/                 Playwright
docs/                要件・設計・タスク
```
