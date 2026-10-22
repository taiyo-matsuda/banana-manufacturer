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

Supabase の定期ジョブ (pg_cron) / Next.js の Route Handler
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

- 1日1回、圃場ごとに Open-Meteo から前日分の時間別データ（気温・降水・風速）を取得して `weather_hourly` に入れ、`weather_daily` に集計する。
- 実行は Supabase の pg_cron ＋ `pg_net`（HTTP 呼び出し）、または Vercel Cron から Route Handler を叩く。MVP では後者（デバッグしやすい）。
- 初回は圃場の登録日から遡って取得する（Open-Meteo の過去データ API）。
- `fields.temperature_offset_c` を加算してから保存する。

## 6. 推定と提案の計算

- 推定（収穫予測日、果房重量）は、関係するイベントが記録されたとき、および気象が更新された後の日次バッチで再計算する。
- 計算は `src/lib/prediction/` の純粋関数。入力は DB から読み、結果は `estimates` に追記する（上書きしない）。
- 提案（`recommendations`）も同じタイミングでルールから生成する。同じ対象・同じ種類で `open` のものがあれば作らない。

## 7. 環境

| 環境 | 用途 |
|---|---|
| ローカル開発 | `npm run dev` ＋ Supabase（開発用プロジェクト、または Supabase CLI のローカル環境） |
| E2E テスト | Playwright。同じ Supabase プロジェクト内のテスト用組織 2 つ（テスト農園 A / B、`0003_test_orgs.sql`）。A をほぼ全テストで使い、B は「A のデータが見えない」という組織分離の検証にだけ使う。本人のアカウントは E2E に使わない |
| E2E の安定化 | **ログインは共有する。** setup プロジェクト（`e2e/auth.setup.ts`）がテスト農園 A / B に 1 回ずつ UI ログインし、Cookie（`storageState`）と supabase-js 用のセッションを `e2e/.auth/`（gitignore）に保存。iphone / desktop は `dependencies: ["setup"]` で A の状態から始まり、B で見るテストは `test.use({ storageState: AUTH_STATE_B })`、未ログインの検証は `noSession`。ログイン画面を実際に通すのは auth.spec の 2 件だけ。DB を直接読み書きするテストは `supabaseAsA()` / `supabaseAsB()`（保存セッションを使い、サインインしない）。Supabase Auth のサインインは IP ごとにレート制限があり、テストごとにログインすると 1 回の実行で上限を超える。**その他:** `workers` は 2 に固定。expect と操作のタイムアウトは全体で 15 秒（開発サーバー＋リモートの Supabase では、遅い時間帯に全テストが 2〜3 倍遅くなり既定の 5 秒が切れる）。登録・確定（Server Action）直後の検証は `ACTION_TIMEOUT`（15 秒）で待つ（1 回の登録で Supabase への往復 5 回が直列に走る）。setup の最後に `/login`、`/`、`/fields`、圃場の詳細、地図を 1 回ずつ開いてウォームアップする（開発サーバーは実行ごとに起動され、ルートの初回アクセスで Turbopack のコンパイルが走るため）。setup の最後に E2E が作った圃場・株・茎と、その観測・イベント・写真（名前が `E2E` で始まる圃場に紐づくもの）を消す（溜まると一覧が数百行になり refresh の応答が数百 KB になる）。観測・イベントは追記のみでアプリの権限では消せないため、掃除は組織名で制限した security definer の DB 関数 `e2e_cleanup_fields`（`0006_e2e_cleanup.sql`）を RPC で 1 回呼ぶ。開発サーバーと baseURL は `127.0.0.1`（IPv4）に固定する（`localhost` は IPv6 の [::1] で繋がる）。Windows では `e2e/global-setup.ts` が開発サーバー（:3000）向けの TIME_WAIT ソケットを数え、6,000 を超えていれば解放を待つ。通常は 1 回の実行で残るのは数百個で、この待ちに入ることはない。TIME_WAIT が解放されず約 9,000 個のまま詰まり、IPv6 の動的ポート（16,384 個）を使い切って Supabase への fetch まで `fetch failed` になった異常が一度あり、PC の再起動で解消した。地図画面（`/fields/[id]/map`）は Client Component で、開発サーバーでは初回表示に Turbopack のコンパイルと MapLibre の読み込みがかかるため、表示待ちも `ACTION_TIMEOUT` |
| 本番 | Vercel ＋ 本番 Supabase ＋ Cloudflare Access |

環境変数（`.env.local`、コミットしない。雛形は `.env.example`）:
```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY   # Publishable key（公開用）。service_role / Secret key は絶対に置かない
E2E_EMAIL / E2E_PASSWORD        # テスト農園 A
E2E_B_EMAIL / E2E_B_PASSWORD    # テスト農園 B
```

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
