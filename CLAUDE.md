# バナナ生育記録・収穫予測システム

沖縄・露地のドワーフナムワ栽培で、圃場・株・茎ごとの事実を蓄積し、収穫時期と収穫量を予測するシステム。
正本は `docs/01_requirements.md`（何を作るか）と `docs/02_design/`（どう作るか）。迷ったらそちらを読む。

## 方針（必ず守る）

- 作業管理より **事実の蓄積** を優先する。
- **観測（事実）・推定・提案の3層を分ける。** 観測とイベントは追記のみ（削除しない。訂正は新レコード＋ `superseded_by`）。推定は `model_version` と `computed_at` を持ち、再計算できる。
- 全テーブルに `organization_id` を持たせる（意図的な非正規化。RLS を単純にするため）。子テーブルの `organization_id` は INSERT トリガーで親からコピーし、アプリからは渡さない。fields だけは親がないので、organization_id は DB の既定値 current_org() で設定する（0004）。
- 品種は **株（Mat）** の属性。圃場には品種の制約を置かない。
- 写真は Photo テーブルが観測・イベントを参照する（逆向きにしない）。
- MVP はスマホ（iPhone）の PWA。ネイティブアプリにはしない。Sign Up は無効。
- 画面の都合をデータモデルに持ち込まない。

## UI の決まり（UX-1 以降。必ず守る）

- 画面は `src/components/ui/`（shadcn/ui）と `src/components/app/`（アプリ固有の部品）の部品で作る。
- `src/app/` に生の `<input>` / `<button>` / `<select>` / `<textarea>` を書かない。
  確認: `grep -rn "<input\|<button\|<select\|<textarea" src/app`（0 件であること。`src/components/ui/` は対象外）。
  例外の生要素（写真の `<input type="file">` など）は `src/components/app/` の部品の中にだけ置く。
- 色・間隔・文字サイズ・角丸は `src/app/globals.css` のトークンに従う（primary は緑 1 色、角丸は 1 種類、間隔は 4 の倍数）。画面ごとに独自の色や `zinc-*` 直書きをしない。
- 文字は本文・入力・ボタンが 16px（`text-base`）以上。例外として補助の文字（ヒント・日時・単位、下部タブのラベル、ヘッダの「戻る」、控えめにする「増えていない（+0）」）は `text-sm`（15px）/ `text-xs`（13px）を使ってよい。それより小さくしない。
- 色の直書きの例外: 写真の全画面ビューア（`photo-thumb.tsx`）は写真を見せるため常に黒背景・白文字（`bg-black` / `text-white`）にする。地図上の点の色（MapLibre の DOM）も従来どおり。
- 新しい画面には `PageHeader`（← 戻る・タイトル・ホーム）と `BottomNav`（ホーム / 地図 / 予測 / 設定）を付ける。通常は `AppScreen` で両方を付ける（ログイン・オフライン画面を除く）。
- 現場の記録ボタンは `RecordButton`（高さ 64px 以上）、数値入力は `NumberField`、ラベル付き入力は `FormField`。タップ領域は 44px 以上（地図上の株の点も、見た目は小さく当たり判定は 44px）。
- 見つからない画面（404）は `src/app/not-found.tsx`（ヘッダのホームと下部タブあり）。
- 未同期件数は `layout.tsx` の `SyncStatus` が 1 つだけ出す（画面ごとに置かない。クライアント遷移で前の画面の DOM が残るため）。
- reviewer はこれらの違反を FAIL にする。

## 技術スタック

- Next.js（App Router、TypeScript、Tailwind）、PWA
- Supabase（PostgreSQL、Auth、Storage、RLS）。マイグレーションは `supabase/migrations/`
- オフライン: IndexedDB（Dexie）＋ 同期キュー
- 地図: MapLibre ＋ 地理院タイル（空中写真）
- 気象: Open-Meteo

## Next.js について

`AGENTS.md` に書かれているとおり、このバージョンの Next.js は学習データと異なる可能性がある。
コードを書く前に `node_modules/next/dist/docs/` の該当ガイドを読むこと。

## ディレクトリ

- `docs/01_requirements.md` — 要件定義（目的、ドメイン、記録の定義、ユースケース、MVP の範囲、要確認事項）
- `docs/02_design/` — 設計（`architecture.md`、`data-model.md`、`screens.md`、`offline-sync.md`、`prediction.md`）
- `docs/03_tasks.md` — タスク一覧と完了条件
- `supabase/migrations/` — スキーマ
- `src/app/` — 画面
- `src/lib/` — ドメインロジック（葉数の累計、積算温度、予測、提案ルール）。UI に依存しない純粋な TypeScript にし、テストを書く

## 開発の進め方（ゲート方式）

タスクは `docs/03_tasks.md` にあり、各タスクに完了条件がある。1タスクずつ、次の順で進める。

1. **implementer** サブエージェント（`.claude/agents/implementer.md`）にタスクを1つ渡して実装させる
2. **reviewer** サブエージェント（`.claude/agents/reviewer.md`）に、仕様・完了条件・自動テスト・実際のブラウザ操作で判定させる
3. reviewer が **PASS** を返したときだけ、`docs/03_tasks.md` のタスクを `[x]` にして次へ進む
4. **FAIL** なら、指摘をそのまま implementer に渡して修正させ、再度 reviewer にかける。PASS するまで繰り返す
5. 同じタスクが3回 FAIL したら、タスクの切り方か完了条件に問題がある。ユーザーに相談する

オーケストレーター（メインのセッション）は実装もレビューもせず、タスクの受け渡しと判定の記録だけを行う。

検証コマンド:
- `npm run check` — 型チェック・lint・単体テスト（Supabase 不要）
- `npm run e2e` — Playwright（iPhone 相当と PC の2プロジェクト。開発サーバーは自動起動）。**E2E の前に `npx supabase start`（Docker Desktop が必要）。** 初回とマイグレーションを足した後は `npx supabase db reset`（マイグレーション＋ `supabase/seed.sql` のテスト農園 A / B）

## 手元の Supabase（0-3 以降。必ず守る）

- 開発（`npm run dev`）と E2E は **手元の Supabase**（`npx supabase start`、`http://127.0.0.1:54321`）を使う。`.env.local` は手元の値（`npx supabase status`）。本番の値は Vercel の環境変数にだけ置く（控えは `.env.remote.local`、コミットしない）。
- **本番（リモート）の Supabase に E2E・計測スクリプト・`supabase db push` をタスク用のセッションから向けない。** `e2e/global-setup.ts` は URL が手元でなければ止まる。本番のデータを見たいときは Vercel の本番で見る。
- 新しいマイグレーションはまず手元で `npx supabase db reset`（または `npx supabase migration up`）で確かめる。本番への適用（`npx supabase db push`）は reviewer の PASS 後に、オーケストレーターがユーザーと行う（手順は `docs/04_ops/deploy.md`）。
- 既存のマイグレーションは編集しない。例外は 0002・0003 だけ（手元に auth ユーザーがないため。`data-model.md` 2.7）。

## 開発ステップ（現在: ステップ 2 完了。ステップ 3「予測と提案」のタスク分割待ち）

1. 事実を記録できる（スキーマ、認証、圃場・株・茎の登録、茎の記録入力、オフライン同期、iPhone PWA）
2. 巡回を支える（今週見る株、近い株の候補、施肥の一括入力、吸芽の採用・株分け、累計葉数の検算）
3. 予測と提案（気象取り込み、積算温度、収穫予測日、提案ルール）
4. 出荷見込み（果房重量の推定、週ごとの見込み、API）

## 用語（コード内の英語名）

| 日本語 | 英語 | 備考 |
|---|---|---|
| 組織（農家） | organization | |
| 圃場 | field | |
| 株 | mat | 位置が固定。品種を持つ |
| 茎 | stem | 親・子・孫。`generation` |
| 吸芽 | sucker | 採用前の茎 |
| 出蕾 | bud emergence | `bud_emerged` |
| 袋掛け | bagging | `bagged` |
| 摘蕾 | debudding | `debudded` |
| 果房 / 段 | bunch / hand | |
| 偽茎周囲長 | pseudostem girth | 地上 1m |
| 累計葉数 | cumulative leaves | 初期葉数 + Σ leaves_new |
| 積算温度 | GDD (growing degree days) | 基準温度 14℃ |
