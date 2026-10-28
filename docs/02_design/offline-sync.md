# 設計: オフライン保存と同期

最終更新: 2026-10-26　要件: `../01_requirements.md` 9章

実装の状況: **書き込みの経路**（観測・イベント・写真）は 1-9。**読み取りのローカルキャッシュ（5 章）は 2-9**。一度同期した圃場・株・茎の画面は、圏外でもオフラインの殻（5.5）で開いて記録できる。
株の作成（配置、株分け）はオンライン前提のまま。例外として、吸芽の発生（2-1）は吸芽の茎（status=sucker）を作るがオフラインで記録できる（茎の id を端末で採番し、RPC が id で冪等）。吸芽の採用・芽かき（2-2）も既存の吸芽の状態を変えるだけなので、outbox 経由でオフラインで記録できる。
アプリの殻（HTML/JS）のオフライン配信は 1-10 の Service Worker。

---

## 1. 方針

- 圃場では圏外になりうる。**記録はまず端末（IndexedDB）に書き、その後サーバーに送る**。オンラインでも同じ経路を通す（経路を2つ持たない）。
- 観測・イベント・写真は追記のみなので、同期で競合が起きない。**id は端末側で UUID を生成**し、サーバーでは `insert ... on conflict (id) do nothing`（supabase-js の `upsert(..., { ignoreDuplicates: true })`）。再送しても二重にならない。
- 株の作成（配置、株分け）はオンライン時のみ可能とする（MVP。株分けの画面はオフラインでは確定を無効にし、理由を表示する）。吸芽の採用・芽かき（2-2）は outbox 経由でオフラインでも記録できる（RPC `adopt_sucker` / `remove_sucker`、イベントの id で冪等）。例外: 吸芽の発生（2-1）で作る吸芽の茎は、イベントと同じく outbox 経由でオフラインでも作れる（吸芽の茎の id とイベントの id を端末で採番。RPC `record_sucker_emerged` が 1 トランザクションで作り、イベントの id で冪等）。読み取り用の端末キャッシュは 5 章（2-9）。

## 2. 端末側のデータ（Dexie）

DB 名 `banana-field-notes`（`src/lib/db/index.ts`）。インスタンスはブラウザでのみ生成する（SSR で `indexedDB` に触らない）。

| ストア | 内容 |
|---|---|
| `outbox` | 送信待ちキュー。index: `id, created_at, stem_id, needs_attention` |
| `pendingPhotos` | 未送信の写真の Blob。`{id（photos.id）, blob, content_type}`。アップロード成功後に消す |
| `fields`, `mats`, `stems`, `observations`, `events`, `photos`, `syncCursors`, `syncMeta` | サーバーのキャッシュと差分のカーソル（5 章、2-9） |

`outbox` の 1 件（`src/lib/offline/types.ts`）:

```
{
  id,               // 送る行の id と同じ（observations.id / events.id / photos.id）
  kind,             // 'observation' | 'event' | 'photo'
  stem_id,          // 画面への重ね合わせ用
  payload,          // 下表
  created_at,       // ISO。この順に送る
  attempts,         // 失敗した回数
  last_error,       // 直近の失敗の理由（"[コード] メッセージ"）
  next_attempt_at,  // バックオフの次回時刻（epoch ms）。null は即時
  needs_attention,  // 1 = 要確認（自動では送らない。手動で再試行）
}
```

| kind | payload | 送り方 |
|---|---|---|
| observation | `{id, stem_id, type, value, observed_at, observed_by}` | `observations` に upsert（ignoreDuplicates） |
| event（`method: 'insert'`） | 枯葉処理 `{id, type: 'leaves_removed', target_type: 'stem', target_id, occurred_at, recorded_by, payload: {count}}` | `events` に upsert（ignoreDuplicates） |
| event（`method: 'record_stem_event'`） | 出蕾・段数・袋掛け・摘蕾・収穫・被害 `{id, stem_id, type, occurred_at, payload, note}` | RPC `record_stem_event(p_id, …)`（0009。同じ id の行があれば何もしない）。茎の状態更新も同じ RPC で行い、outbox では 1 件 |
| event（`method: 'record_sucker_emerged'`） | 吸芽の発生（2-1）`{id, type: 'sucker_emerged', sucker_stem_id, parent_stem_id, occurred_at, payload: {sucker_stem_id, parent_cumulative_leaves, earliest_at, direction, sucker_type}, note}`。outbox の `stem_id` は親茎 | RPC `record_sucker_emerged(p_event_id, p_sucker_stem_id, p_parent_stem_id, …)`（0010。同じイベント id の行があれば何もしない）。吸芽の茎（status=sucker）と親茎のイベントを 1 トランザクションで作る。株の詳細は未送信の吸芽を「未同期」の茎として重ねる |
| event（`method: 'adopt_sucker'`） | 吸芽の採用（2-2）`{id, type: 'sucker_adopted', stem_id, occurred_at, payload: {initial_leaf_count}}`。outbox の `stem_id` は吸芽 | RPC `adopt_sucker(p_event_id, p_stem_id, p_occurred_at, p_initial_leaf_count)`（0011。同じイベント id の行があれば何もしない）。栽培中 3 本の違反（トリガー）は日本語の例外 → 要確認。株の詳細は未送信の採用を見かけの状態（栽培中・初期葉数）として重ねる |
| event（`method: 'remove_sucker'`） | 吸芽の芽かき（2-2）`{id, type: 'sucker_removed', stem_id, occurred_at, payload: {}, note}` | RPC `remove_sucker(p_event_id, p_stem_id, p_occurred_at, p_note)`（0011。冪等）。株の詳細は見かけの状態を「芽かき」にする |
| photo | `{id, target_type: 'stem', target_id, storage_path, content_type, taken_at, taken_by, lat, lng, kind, uploaded}` | 4 章の写真の流れ |

`observed_by` / `recorded_by` / `taken_by` はログインユーザーの id（サーバーが画面の props で渡す）。`organization_id` は渡さない（INSERT トリガーが親からコピーする）。

## 3. 書き込みの流れ

```
画面でタップ
  → 端末で crypto.randomUUID() を採番
  → Dexie の outbox に追加（写真は pendingPhotos に Blob も）   … src/lib/offline/enqueue.ts
  → 画面は outbox の liveQuery を購読していて即時反映（サーバーの行 + 未送信分の重ね合わせ）
  → 同期ワーカーが outbox を順に送る（記録直後に起動）
  → 1 件以上送れたら router.refresh() でサーバーの最新に揃える
```

- 重ね合わせ（`src/lib/offline/overlay.ts`、純粋関数）: サーバーの観測・イベント・写真に、この茎の未送信分を `created_at` 順に重ねる。同じ id がサーバーにもあれば重ねない。未送信の行は `pending=true`（履歴に「未同期」の印）。
- 茎の「見かけの状態」: 未送信の茎イベント（出蕾 → flowered、収穫 → harvested、被害 lost → lost）を `src/lib/stemEvents.ts` の遷移で適用する。記録ボタンの出し分け（`canRecordLeaves` / `canRecordEvent`）はこの状態で判定する。
- 出蕾の `cumulative_leaves` は端末側で、画面が持つ観測 + 未送信分から計算して payload に入れる。生葉数・偽茎周囲長の観測 2 行は別の outbox 項目（observation）として積む。
- 送信済みで outbox から消えたが `router.refresh()` の結果（props）にまだ無い行は、props に現れるまで画面側で保持する（一瞬消えて見えないように）。

## 4. 同期

実装: `src/lib/offline/worker.ts`（ループ本体。outbox の読み書きと送信は注入。単体テストあり）、`src/lib/offline/sender.ts`（supabase-js で送る。3-3: 出蕾・茎の被害を送れたら `POST /api/predictions/recompute` でその茎の収穫予測日を再計算させる。3-4: 同じ呼び出しで提案も評価し、袋掛け・摘蕾・収穫を送れたときも呼ぶ。失敗しても送信は成功のまま。prediction.md 2・6 章）、`src/lib/offline/sync-client.ts`（起動・多重実行の防止・タイマー）、`src/lib/offline/retry.ts`（失敗の分類・バックオフ。単体テストあり）。

- トリガー: アプリ起動時、`online` イベント、画面復帰（`visibilitychange`）、記録直後、手動ボタン（ヘッダの同期状態画面）。全画面のヘッダ `SyncStatus` が起動時に 1 回だけ登録する。
- 同時に 2 つのワーカーは走らせない（実行中に要求が来たら「終わったらもう一度」の印だけ立てる）。
- outbox を `created_at` 順に処理する。1 件ずつ送り、成功したら outbox から消す。要確認とバックオフ中の項目は飛ばして次へ進む。
- `navigator.onLine` が false のときは送らない（attempts を無駄に増やさない。`online` イベントで再開）。
- 写真: まず Storage にアップロード（同じパスに `upsert: true`）→ 成功したら outbox の `payload.uploaded = true` を保存し `pendingPhotos` の Blob を消す → `photos` に upsert（`upload_status = uploaded`）。Storage の成功後に DB が失敗した場合、再送は DB だけやり直す。
- 失敗: `attempts` を増やし `last_error` を保持。再試行するかどうかは純粋関数 `classifySendError` で分ける:
  - **再試行**（指数バックオフ 1s, 2s, 4s … 上限 1 分。`next_attempt_at` にタイマー）: ネットワークの失敗（fetch の `TypeError` / `Failed to fetch` / `Load failed`、圏外）、5xx、408 / 429。**5 回失敗したら「要確認」**
  - **再試行せず即「要確認」**（再送しても直らない）: 認証エラー（401 / 403）、バリデーション系（その他の 4xx、PostgREST の `PGRSTxxx`、PostgreSQL の SQLSTATE（RPC の状態前提違反 `P0001`、制約違反 `23xxx`、RLS `42501` など））、端末に写真の Blob が残っていない
- 要確認はヘッダの未同期件数からたどれる同期状態画面に一覧（`last_error` 付き）で出し、1 件ずつ・まとめて手動で再試行できる（要確認を外して即送る）。
- 未同期件数 = outbox の件数（要確認も含む）。全画面のヘッダに表示（0 でも表示）。Dexie の `liveQuery` で購読する。

## 5. 読み取り（端末キャッシュ、2-9）

### 5.1 方針

- **オンラインでは今までどおりサーバー（RSC）から描画する**（PERF-1 で十分速いので、全画面をクライアント描画に作り替えない）。そのうえで、端末のキャッシュ（Dexie）に組織のデータを入れておき、差分同期で最新に保つ。
- **オフライン（またはサーバーに届かない）とき**は、Service Worker がキャッシュ済みでないページへのナビゲーションに「オフライン用の殻」を返し、殻が URL を読んで Dexie のデータで画面を描画する。これで、一度同期した圃場・株・茎の画面を圏外でも開いて記録できる（1-9 の制限「オンラインのうちに開いておいた画面だけ」をなくす）。
- 殻の画面は、既存の画面の部品（ヘッダ・茎の行・記録ボタン・履歴の行など）を**共有**する。違うのはデータの取り方だけ（RSC の props か、Dexie から組み立てた同じ形のデータか）。画面ごとに別実装を作らない。
- キャッシュはデータの「写し」であって正本ではない。書き込みは従来どおり outbox → サーバー（3・4 章）。キャッシュを直接書き換えて記録の代わりにしない。
- 25a・400 株・数年分でも数万行程度なので、組織の全データを端末に持って問題ない。

### 5.2 サーバー側: `updated_at`（`supabase/migrations/0017_updated_at.sql`）

- `fields`、`mats`、`stems`、`observations`、`events`、`photos` に `updated_at timestamptz not null default now()` を追加する（既存の行は `now()` で埋まる）。更新時に `updated_at = now()` を入れる BEFORE UPDATE トリガー（共通関数 `set_updated_at()`）と、`(organization_id, updated_at)` の索引を付ける。
- **追記のみの検査との関係**: 0001 の `forbid_update_except_supersede()` は `superseded_by` 以外の列の変化を拒否するので、そのままでは `updated_at` の自動更新と衝突する。関数を `create or replace` で差し替え、比較から `superseded_by` と `updated_at` の両方を除く（`to_jsonb(new) - 'superseded_by' - 'updated_at' <> to_jsonb(old) - 'superseded_by' - 'updated_at'`）。それ以外の列の変更は引き続き拒否する（0001 の意図を保つ）。
- トリガーの実行順: 同じ表の BEFORE トリガーは名前のアルファベット順に動く（`*_append_only` → `*_set_updated_at`）。追記のみの検査は `updated_at` を比較から除くので、どちらが先でも結果は同じ。アプリが `updated_at` を直接書いても、後に動く `set_updated_at` が `now()` で上書きする。
- 観測・イベントは訂正（2-6）で元の行の `superseded_by` が更新されるので `updated_at` が変わり、差分同期で訂正が端末に届く。
- 既存の 0001〜0016 は編集しない。

### 5.3 端末側のストア（Dexie のバージョン 2）

| ストア | 内容 |
|---|---|
| `fields`, `mats`, `stems`, `observations`, `events`, `photos` | サーバーの行の写し（RLS で見えた列そのまま。写真はメタデータだけで画像本体は入れない）。主キー `id`。画面の組み立てに使う索引（`mats.field_id`、`stems.mat_id`、`observations.stem_id`、`events.[target_type+target_id]`、`photos.[target_type+target_id]` など） |
| `syncCursors` | テーブルごとの差分のカーソル `{table, updated_at, id}`（前回取り込んだ最後の行） |
| `syncMeta` | `{key: 'meta', organization_id, user_id, last_synced_at, last_full_at}`（最終同期の日時、最後に全件を取り直した日時、キャッシュの持ち主） |

- `outbox` と `pendingPhotos` は従来どおり（2 章）。キャッシュの入れ替えでは消さない（消すのは 5.7 のログアウトだけ）。
- 集計（0016 の `weekly_stems` など）はキャッシュしない。キャッシュの行から `src/lib/weekly.ts` などの既存の純粋関数で計算し直す。

### 5.4 差分の取り込み

- テーブルごとに `updated_at > カーソル` の行を `order by updated_at, id` で **1,000 件ずつ**ページングして取り込む（PostgREST の上限）。同時刻の行の取りこぼしを防ぐため、カーソルは `(updated_at, id)` の組にし、条件は「`updated_at > c.updated_at` または（`updated_at = c.updated_at` かつ `id > c.id`）」にする（境界を `>=` にして id で重複を除く方式でもよい）。1 ページの最後の行でカーソルを進め、件数が 1,000 未満になったら終わり。
- 初回（カーソルなし）は全件。条件に組織は書かない（RLS が自組織に絞る）。
- 取り込みは `bulkPut`（id で上書き）。親より子が先に来ても問題ない（画面の組み立て時に結合する）。
- **全件の取り直し**: サーバー側で消えた行（E2E の掃除など）は差分では分からない。24 時間に 1 回（`last_full_at` から 24 時間）と、同期状態画面の「全件を取り直す」ボタンで、全件を取得してキャッシュを置き換える（取得が全部終わってから入れ替える。途中で失敗したら前のキャッシュを残す）。
- トリガー: 起動時（`SyncStatus` の登録時）、`online` イベント、画面復帰（`visibilitychange` で visible）、同期状態画面の手動ボタン。outbox の送信（4 章）とは別の処理だが、同じく多重実行しない（実行中の要求は「終わったらもう一度」）。outbox の送信が成功した後にも 1 回走らせ、送った行をキャッシュに入れる。
- オフライン（`navigator.onLine === false`）では取り込まない。失敗しても outbox のような要確認にはせず、次のトリガーでやり直す。
- 純粋関数（カーソルの比較と更新、ページの条件、マージ、全件の入れ替えの判定、キャッシュからの画面用データの組み立て）は `src/lib/` に置き単体テストする。Supabase と Dexie は注入する。

### 5.5 オフラインの殻

- 対象の URL: `/`（ホーム）、`/fields/[id]`（圃場の詳細）、`/fields/[id]/map`（地図）、`/mats/[id]`（株の詳細）、`/stems/[id]`（茎の記録入力）、`/stems/[id]/history`（履歴）。
- 殻は 1 枚の Client Component のページ（`src/app/offline-shell/`）。Service Worker が install で precache し、上の URL へのナビゲーションで「ネットワークに届かず、ナビゲーションのキャッシュにも無い」ときに返す（上の URL 以外は従来どおり `/offline`）。殻は `location.pathname` を読み、Dexie から画面のデータを組み立てて、既存の画面の部品で描画する。
- 殻の上部に「オフライン表示（最終同期: 日時）」を出す（`syncMeta.last_synced_at`、Asia/Tokyo）。キャッシュに対象の行が無いとき・一度も同期していないときは「この画面のデータは端末にありません。オンラインで一度同期してください」。
- 地図: 空中写真タイルはオフラインでは出ないので、理由（「地図はオフラインでは表示できません」）を表示し、株の一覧から選べるようにする（株の点だけを背景なしで描いてもよい）。
- 写真: 画像本体はキャッシュしないので、サムネイルの代わりに「写真（オフラインでは表示できません）」を出す。
- 殻からの記録は既存の outbox に積む（1-9・2-1・2-2 と同じ経路と重ね合わせ）。株の作成・訂正・一括入力などオンライン前提の操作は従来どおり無効にして理由を出す。
- 気温（weather_*）はキャッシュしない（3-2）。殻の茎の画面では、出蕾済みの茎の「積算温度」の区画に「オフラインでは積算温度を表示できません」を出す（ほかの表示は従来どおり）。圃場の詳細の「気温」「予測の設定」も殻には出さない
- 殻の中の画面間の移動（株 → 茎など）も殻の中で完結させる（RSC の取得はオフラインで失敗するため）。

### 5.6 未送信分の重ね合わせ

- 殻の画面は、キャッシュの行に outbox の未送信分を `src/lib/offline/overlay.ts` で重ねる（3 章と同じ）。
- **履歴画面（`/stems/[id]/history`）にも未送信分を重ねる**（1-9 で未対応だったもの）。オンラインの RSC の履歴でも殻の履歴でも、未送信の行は「未同期」の印付きで出す。

### 5.7 ログアウトと別ユーザー

- ログアウト時に Dexie のキャッシュ（6 テーブル）・`syncCursors`・`syncMeta` を消す。outbox に未送信の記録が残っていれば、ログアウトの前に「未同期の記録が N 件あります。ログアウトすると失われます」と確認し、了承したら outbox と `pendingPhotos` も消す（別のユーザーの記録として送らないように）。
- 取り込みの前に `syncMeta` の `organization_id` / `user_id` と現在のログインを比べ、違えばキャッシュを消してから全件を取り込む。キャッシュに他組織の行が入らないことは、RLS（取得の時点）とこの比較（端末の持ち主の交代）で守る。
- Service Worker のナビゲーションのキャッシュ（`shell-*` の HTML）もログアウト時に消す（別ユーザーが圏外で前のユーザーの画面を見ないように。殻と `/offline` は残してよい）。

### 5.8 E2E（`e2e/cache.spec.ts`）

- 完了条件 1: オンラインでホームを開き同期完了を待つ → `context.setOffline(true)` → **まだ開いていない**別の株の詳細・別の茎の画面へ `page.goto` → 表示される → +1 → 未同期 1 → オンライン → サーバーに行がある。
- 完了条件 2: `supabaseAsA()` で別の端末の記録として観測を insert → こちらで差分同期（画面復帰か手動） → オフラインにしてその茎の画面に記録が出る。
- ほかに: 訂正（2-6）がキャッシュに反映される、ログアウトでキャッシュが消える（未同期ありの確認ダイアログも）、履歴画面に未送信分が「未同期」で出る、殻に最終同期の日時が出る。
- E2E の掃除で行が消えても、各テストの初回同期（全件）で整合するようにする。

## 6. iPhone Safari の注意

- ホーム画面に追加して使う前提。追加していない Safari は7日間未使用でストレージを消すことがある
- 写真の Blob は IndexedDB に入るが、容量を使うのでアップロード成功後に Blob を消す
- Service Worker はアプリの殻（HTML/JS/CSS、地図タイルの一部）をキャッシュする。データは Dexie が担当し、SW はデータの同期をしない（Background Sync は iOS で使えない）

## 7. E2E での検証

- Playwright の `context.setOffline(true)` で圏外を再現し、記録 → 未同期件数が増える → `setOffline(false)` → 同期されサーバーに行がある、を確認する（`e2e/offline.spec.ts`）
- オフライン中は Next.js のクライアントナビゲーションや RSC の取得も失敗する。1-9 のテストはオフラインにする前に茎の画面を開いておく。2-9 以降、開いていない画面は `page.goto` でオフラインの殻（5.5）が出る（5.8）
- オンラインでも同じ経路（outbox → 同期）を通るので、DB を直接確かめる・再読み込みする前に未同期件数が 0 になるのを待つ（`e2e/helpers.ts` の `waitForSynced`）
- サーバーに拒否される記録（状態の前提違反）は、Dexie の `outbox` に IndexedDB で直接項目を入れて再現し、要確認の表示と手動再試行を確かめる
