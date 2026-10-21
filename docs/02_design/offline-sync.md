# 設計: オフライン保存と同期

最終更新: 2026-10-21　要件: `../01_requirements.md` 9章

---

## 1. 方針

- 圃場では圏外になりうる。**記録はまず端末（IndexedDB）に書き、その後サーバーに送る**。オンラインでも同じ経路を通す（経路を2つ持たない）。
- 観測・イベント・写真は追記のみなので、同期で競合が起きない。**id は端末側で UUID を生成**し、サーバーでは `insert ... on conflict (id) do nothing`。再送しても二重にならない。
- 株・茎の作成（配置、採用、株分け）はオンライン時のみ可能とする（MVP）。読み取り用に端末にキャッシュは持つ。

## 2. 端末側のデータ（Dexie）

| ストア | 内容 |
|---|---|
| `fields`, `mats`, `stems` | サーバーのキャッシュ。起動時と同期時に更新 |
| `observations`, `events` | サーバーのキャッシュ ＋ 未送信分 |
| `photos` | メタデータ。未送信分は Blob も持つ |
| `outbox` | 送信待ちキュー。`{id, kind: observation/event/photo/stem_status, payload, created_at, attempts, last_error}` |

## 3. 書き込みの流れ

```
画面でタップ
  → 端末の UUID を採番
  → Dexie に行を書く（observations など）＋ outbox に追加
  → 画面は Dexie から再描画（即時反映）
  → 同期ワーカーが outbox を順に送る
```

## 4. 同期

- トリガー: アプリ起動時、`online` イベント、画面復帰（`visibilitychange`）、記録直後、手動ボタン
- outbox を `created_at` 順に処理する。1件ずつ送り、成功したら outbox から消す
- 写真: まず Storage にアップロード → 成功したら `photos` 行を insert（`upload_status=uploaded`）。Storage の成功後に DB 失敗した場合は再送で DB だけやり直す（Storage は同じパスに upsert）
- 茎の状態更新（出蕾→flowered など）はイベント insert と同じ RPC で行い、outbox では1件として扱う
- 失敗: `attempts` を増やし、指数バックオフ。5回失敗したら「要確認」としてホームに表示し、手動で再試行できる。エラー内容は `last_error`
- 未同期件数 = outbox の件数。全画面のヘッダに表示

## 5. 読み取り

- 画面は Dexie から読む。サーバーからの取得は「同期」の一部として Dexie を更新する
- 取得は組織の全データを `updated_at > 前回同期時刻` で差分取得（テーブルに `updated_at` を持たせる。追記のみテーブルは `created_at` で代用）
- 25a・400株・数年分でも数万行程度なので、全件を端末に持って問題ない

## 6. iPhone Safari の注意

- ホーム画面に追加して使う前提。追加していない Safari は7日間未使用でストレージを消すことがある
- 写真の Blob は IndexedDB に入るが、容量を使うのでアップロード成功後に Blob を消す
- Service Worker はアプリの殻（HTML/JS/CSS、地図タイルの一部）をキャッシュする。データは Dexie が担当し、SW はデータの同期をしない（Background Sync は iOS で使えない）

## 7. E2E での検証

- Playwright の `context.setOffline(true)` で圏外を再現し、記録 → 未同期件数が増える → `setOffline(false)` → 同期されサーバーに行がある、を確認する
