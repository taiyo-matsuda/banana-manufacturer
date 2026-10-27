# 設計: データモデル

最終更新: 2026-10-21　要件: `../01_requirements.md` 4〜5章　実装: `../../supabase/migrations/`

---

## 1. 全体

```
organizations ─┬─ profiles（auth.users と 1:1）
               ├─ fields ─┬─ soil_analyses ── soil_analysis_items
               │          ├─ field_cultivar_params（圃場 × 品種の予測パラメータ上書き）
               │          ├─ weather_hourly / weather_daily
               │          └─ mats ── stems ─┬─ observations
               │                            ├─ events（target_type/target_id で stem/mat/field を指す）
               │                            ├─ photos（同上。observation_id / event_id は任意）
               │                            └─ estimates
               └─ recommendations（target_type/target_id）
cultivars（全組織で共有）
```

## 2. 設計上の約束

### 2.1 organization_id の非正規化
すべてのテーブルに `organization_id` を持つ。理由は RLS のポリシーを全テーブルで
`organization_id = current_org()` の1条件にするため。JOIN で親をたどるポリシーは行ごとに評価されて重く、ミスも入りやすい。

整合性は **INSERT トリガーで親からコピーする**ことで保証する。アプリは `organization_id` を渡さない。
`fields` は親がないため、列の既定値 `current_org()`（`0004_fields_default_org.sql`）で設定する。

| テーブル | コピー元 |
|---|---|
| mats, field_cultivar_params, soil_analyses, weather_*（weather_sync_status を含む） | fields |
| stems | mats |
| observations, estimates | stems |
| soil_analysis_items | soil_analyses |
| events, photos, recommendations | target_type に応じて stems / mats / fields |

### 2.2 追記のみ
`observations` と `events` は削除しない。UPDATE は `superseded_by` 列だけ許可する（トリガーで他の列の変更を拒否）。
訂正は新しいレコードを追加し、元のレコードの `superseded_by` に新レコードの id を入れる。
読み取り時は `superseded_by is null` の行だけを「現在の値」として扱う。
例外: E2E 専用組織（組織名が「テスト農園」で始まる）の掃除だけは、組織名で制限した security definer 関数 `e2e_cleanup_fields(prefix)`（`0006_e2e_cleanup.sql`）で観測・イベントごと消す。本番の組織では例外を投げる。

### 2.3 推定は観測と別
`estimates` は `model_version` と `computed_at` を持ち、再計算のたびに追記する。最新は `computed_at desc` の先頭。

### 2.4 品種は株の属性
`mats.cultivar_id` が必須。`fields` に品種は持たない。

### 2.5 写真の参照の向き
`photos` が `observation_id` / `event_id` を持つ。観測・イベント側に写真の配列は持たない。

### 2.6 座標
MVP では `lat` / `lng` の数値列。PostGIS は使わない（必要になったら移行）。
`fields.boundary` は GeoJSON を jsonb で持つ（後回し）。

### 2.7 マイグレーションの扱い
既存のマイグレーションは編集しない（変更は新しいマイグレーションを追加する）。新しいマイグレーションはまず手元の Supabase
（`npx supabase db reset`）で確かめ、本番への適用（`npx supabase db push`）は reviewer の PASS 後にオーケストレーターがユーザーと行う
（`docs/04_ops/deploy.md`）。

**例外: `0002_initial_org.sql`・`0003_test_orgs.sql`（タスク 0-3 で編集）。** どちらも環境固有のデータ（本番のオーナー、
E2E のテストユーザー）の `profiles` 行を入れるが、`profiles.id` は `auth.users` への FK なので、そのユーザーがいない手元の
Supabase（`npx supabase start` / `db reset`。マイグレーションはシードより先に走る）では FK 違反で失敗し、以降が適用できなかった。
そのためこの 2 本に限り、`insert ... select ... where exists (select 1 from auth.users where id = ...)` の形にし、ユーザーがいない
環境では何もしないように直した。組織の行は FK がないのでそのまま入る。手元のテスト農園 A / B の auth ユーザーと `profiles` は
シード `supabase/seed.sql` が作る（`on conflict do nothing` で重複しない）。リモート（本番）では適用済みで再実行されないので影響しない。

## 3. テーブル

### organizations
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid | PK |
| name | text | |

### profiles
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid | PK、`auth.users.id` |
| organization_id | uuid | |
| display_name | text | |
| role | text | 当面 `owner` のみ |

### cultivars（共有マスタ）
| 列 | 型 | 備考 |
|---|---|---|
| id | uuid | |
| name | text | unique。初期値「ドワーフナムワ」 |
| base_temp_c | numeric | 既定 14.0 |
| flowering_to_harvest_gdd | numeric | 既定 900 |
| leaves_to_flowering | int | 未設定可 |

### fields
| 列 | 型 | MVP | 備考 |
|---|---|---|---|
| id, organization_id | uuid | 必須 | |
| name | text | 必須 | 組織内で unique |
| code | text | 必須 | 圃場記号。英数字 1〜4 文字（大文字）。組織内で unique。株コード `圃場記号-連番` に使う（`0005_field_code.sql`） |
| center_lat, center_lng | double | 必須 | 代表点 |
| notes | text | 任意 | |
| boundary | jsonb | 後回し | GeoJSON Polygon。筆ポリゴンから取り込む |
| weather_lat, weather_lng | double | 後回し | 空なら center |
| temperature_offset_c | numeric | 後回し | 既定 0 |

### field_cultivar_params
PK (field_id, cultivar_id)。`cultivars` の各値を上書きする nullable 列を持つ。

### soil_analyses / soil_analysis_items
- soil_analyses: id, organization_id, field_id, sampled_at, source_photo_id（任意）, note
- soil_analysis_items: soil_analysis_id, item（'pH', 'EC', 'CEC', 'OM', 'N', 'P', 'K', 'Ca', 'Mg' …）, value, unit。(soil_analysis_id, item) unique

### mats
| 列 | 型 | 備考 |
|---|---|---|
| id, organization_id, field_id | uuid | |
| code | text | 例 `A-012`。(field_id, code) unique |
| cultivar_id | uuid | 必須 |
| lat, lng | double | |
| planted_at | date | この位置に植えた日 |
| origin_type | enum | `tissue_culture` / `sucker_purchased` / `sucker_transplant` |
| origin_stem_id | uuid | 株分け元の茎（`sucker_transplant` のとき） |
| status | enum | `active` / `removed` |

### stems
| 列 | 型 | 備考 |
|---|---|---|
| id, organization_id, mat_id | uuid | |
| generation | int | 親=1, 子=2, 孫=3 … |
| parent_stem_id | uuid | 同じ株内の親茎 |
| status | enum | `sucker` / `active` / `flowered` / `harvested` / `removed` / `transplanted` / `lost` |
| started_at | date | 吸芽の発生日、または植え付け日 |
| adopted_at | date | 栽培中として採用した日 |
| initial_leaf_count | int | 採用時/植え付け時の葉数 |
| first_broad_leaf_at | date | 幅広葉が出始めた日 |
| bud_emerged_at, bagged_at, harvested_at, ended_at | date | イベントから更新される冗長項目（検索用） |

制約: 株ごとに `status in ('active','flowered')` の茎は最大3本（トリガー）。

状態遷移:
```
sucker ─┬─ sucker_adopted ──▶ active ── bud_emerged ──▶ flowered ── harvested ──▶ harvested
        ├─ sucker_removed ──▶ removed
        └─ sucker_transplanted ─▶ transplanted（転出先の mat が作られ、その generation=1 の stem は started_at を引き継ぐ）
active / flowered ── damage(喪失) ──▶ lost
```

### observations（追記のみ）
| 列 | 型 | 備考 |
|---|---|---|
| id, organization_id, stem_id | uuid | |
| type | enum | `leaves_new` / `leaves_current` / `pseudostem_girth_cm` / `height_cm` |
| value | numeric | |
| observed_at | timestamptz | |
| observed_by | uuid | profiles.id |
| note | text | |
| superseded_by | uuid | 訂正レコードの id |

### events（追記のみ）
| 列 | 型 | 備考 |
|---|---|---|
| id, organization_id | uuid | |
| type | enum | 下表 |
| target_type, target_id | enum, uuid | `stem` / `mat` / `field` |
| occurred_at | timestamptz | |
| recorded_by | uuid | |
| payload | jsonb | 下表 |
| note | text | |
| superseded_by | uuid | |

| type | target | payload |
|---|---|---|
| bud_emerged | stem | `{cumulative_leaves, leaves_current, girth_cm, earliest_at}` |
| hands_counted | stem | `{hands}` |
| bagged | stem | `{}` |
| debudded | stem | `{}` |
| harvested | stem | `{weight_kg}` |
| leaves_removed | stem | `{count}` |
| fertilized | mat | `{fertilizer, amount, unit, batch_id}`（一括入力は株ごとに展開。batch_id で束ねる） |
| damage | stem / mat / field | `{kind: 倒伏/裂葉/折損/寒害/病害, severity: light/moderate/severe/lost}`。lost は stem のときだけ（圃場・株では選べない。株を失ったなら mat_removed）。メモ（例: 台風 14 号）は `note` 列。圃場の被害から株へ一括で記録したもの（2-5）は mat ごとに展開し、payload に `field_event_id`（元の圃場の被害イベント）と `batch_id`（確定ごとに 1 つ。再送で二重にしない）を足す |
| sucker_emerged | stem（親茎） | `{sucker_stem_id, parent_cumulative_leaves, earliest_at, direction, sucker_type}`。同時に新しい stem を status=sucker、parent_stem_id=親茎、generation=親+1 で作る。`parent_cumulative_leaves` はその時点の親の累計葉数を自動で記録（残す吸芽の基準 X の根拠。要件 5.3）。`direction` は 8 方位（N/NE/E/SE/S/SW/W/NW）、`sucker_type` は `sword`（剣葉）/ `water`（水吸芽） |
| sucker_adopted | stem | `{initial_leaf_count}` |
| sucker_removed | stem | `{}` |
| sucker_transplanted | stem | `{to_mat_id}` |
| stem_removed | stem | `{reason}` |
| mat_removed | mat | `{reason}` |

イベントから `stems.status` と日付列を更新するのはアプリ側の責務（同一トランザクション内で行う RPC を用意する）。

### photos
| 列 | 型 | 備考 |
|---|---|---|
| id, organization_id | uuid | |
| storage_path | text | unique |
| taken_at | timestamptz | EXIF |
| taken_by | uuid | |
| lat, lng | double | EXIF または端末 GPS |
| target_type, target_id | | 必須 |
| observation_id, event_id | uuid | 任意 |
| kind | enum | `side` / `bud` / `bunch` / `damage` / `other` |
| upload_status | enum | `local` / `uploaded` |

### weather_hourly / weather_daily
- hourly: (field_id, ts, source) PK。temp_c, precip_mm, wind_max_ms
- daily: (field_id, date, source) PK。t_mean, t_min, t_max, precip_mm, gdd（基準温度は品種で違うため t_mean も保持し、再計算できるようにする）
- 3-1（`0018_weather_sync.sql`）で追加した列（hourly / daily 共通）:
  - `api`（`forecast` / `archive`）: Open-Meteo のどの API の値か。**1 日 1 行（`source = 'open-meteo'`）で、予報 API の暫定値を後日 過去 API の確定値で upsert して上書きする**（`source` は分けない。読む側は日付で 1 行を引けばよい）。`forecast` の行は「まだ確定していない」印で、確定値が出る 5 日を過ぎたら過去 API で取り直す
  - `temperature_offset_c`: 保存した気温に加えた圃場の補正（取得時の `fields.temperature_offset_c`）。**保存値 = Open-Meteo の値 + この補正**。補正が今の圃場の値と違う行は、次の取り込みで取り直す
  - `fetched_at`: 取得した日時
  - daily の `wind_max_ms`: 時間別の風速（10m、m/s）の日最大
- 日次は時間別から集計する（`src/lib/weather/aggregate.ts`）: 日平均（24 時間の平均）・最低・最高・降水合計・最大風速。日付の境界は Asia/Tokyo（Open-Meteo に `timezone=Asia/Tokyo`）。気温が 24 時間そろわない日は保存しない。`gdd` は 3-1 では入れない（基準温度が品種ごとなので 3-2 で `t_mean` / 時間別から計算する）
- 何を保存するか（`src/lib/weather/plan.ts`）:
  - 日次: 平年値の材料（今年 1/1 の 10 年前 〜 昨年末。圃場あたり約 3,650 行）＋ 埋めるべき期間（圃場の登録日と最も古い茎の `started_at` の早い方 〜 昨日）＋ 直近 7 日（予報 API）
  - 時間別: 埋めるべき期間と直近 7 日だけ（10 年分は日次だけ）
  - 取り込みのたびに、上の期間で確定値（`api = archive`、補正が一致）のない日を探し、まとめて過去 API で取る（失敗した日は次回の対象に残る）
- 代表点（`weather_lat/lng`、なければ `center_lat/lng`）が前回の取り込みと変わっていたら、その圃場の weather_* を消して取り直す（外部の値なので「追記のみ」の対象ではない）

### weather_sync_status（3-1、0018）
圃場ごとの気温の取り込みの記録。PK `field_id`（fields を on delete cascade）。organization_id は fields からトリガーでコピー。
| 列 | 備考 |
|---|---|
| last_run_at | 最後に取り込みを実行した日時 |
| last_days | その回に保存した日別の行数（日付の数。予報と過去の両方で書いた日も 1 日） |
| last_error | その回の失敗の要約（API・理由・欠けた日数。`src/lib/weather/summary.ts`。期間ごとの詳細はサーバーのログ）。なければ null |
| last_success_at, last_success_days | 最後に成功した回（エラーなし、または 1 日以上保存できた回）の日時と保存した日数（0019）。画面の「最終取得」はこれ |
| lat, lng | 前の地点の値を消し終えた（または変更がなかった）座標（代表点の変更の検出）。変更を確かめられなかった・消せなかった回は前の値のまま（record_weather_sync に null を渡す。0019） |
| updated_at | |

RLS は自組織の select のみ。書き込みは security definer の `record_weather_sync()` だけ（呼べるのはその圃場の組織のユーザーか service_role）。

### estimates
| 列 | 型 | 備考 |
|---|---|---|
| id, organization_id, stem_id | uuid | |
| kind | enum | `harvest_date` / `bunch_weight_kg` / `cumulative_leaves` / `bud_date` |
| value, lower, upper | numeric | 数値の推定 |
| value_date, lower_date, upper_date | date | 日付の推定 |
| model_version | text | |
| inputs | jsonb | 計算に使った入力 |
| computed_at | timestamptz | |

### recommendations
| 列 | 型 | 備考 |
|---|---|---|
| id, organization_id | uuid | |
| kind | enum | `bag` / `debud` / `harvest_window` / `fertilize_after_harvest` / `remove_dead_leaves` / `inspect` |
| target_type, target_id | | |
| due_at | date | |
| reason | text | |
| status | enum | `open` / `done` / `dismissed` |
| resolved_at, resolved_by | | |

### weekly_stems（view、0016。2-7 今週見る株）
画面 1「今週見る株」を 1 回の問い合わせで引くための読み取り専用の view。`security_invoker = true`（呼び出したユーザーの RLS がそのまま効く）。
撤去していない株（`mats.status = 'active'`）の、栽培中・出蕾済み（`stems.status in ('active','flowered')`）の茎ごとに 1 行。

| 列 | 由来 | 備考 |
|---|---|---|
| stem_id, mat_id, generation, status, started_at, bud_emerged_at, initial_leaf_count | stems | |
| mat_code, mat_status, field_id | mats | |
| field_name | fields.name | |
| last_leaves_new_at | max(observations.observed_at) | `type = 'leaves_new'` かつ `superseded_by is null`。観測がなければ null |
| leaves_new_sum | sum(observations.value) | 同上。なければ 0。累計葉数 = initial_leaf_count + leaves_new_sum |

並べ替え・閾値（7 / 14 日）・今日の除外・未同期分の重ね合わせは `src/lib/weekly.ts`（純粋関数）。観測は全件引かない（茎ごとの要約だけ）。

## 4. RLS

| テーブル | select | insert | update | delete |
|---|---|---|---|---|
| organizations | 自組織 | × | × | × |
| profiles | 自組織 | × | × | × |
| cultivars | 全員 | × | × | × |
| fields, field_cultivar_params, soil_*, mats, stems, weather_hourly, weather_daily, estimates, recommendations | 自組織 | 自組織 | 自組織 | 自組織 |
| weather_sync_status | 自組織 | ×（record_weather_sync() のみ） | 同左 | × |
| observations, events | 自組織 | 自組織 | superseded_by のみ（トリガーで制限） | × |
| photos | 自組織 | 自組織 | 自組織（upload_status の更新） | × |

## 5. 派生値の計算場所

| 値 | どこで | 備考 |
|---|---|---|
| 累計葉数 | `src/lib/leaves.ts` | 画面表示のたびに観測から計算。今週見る株は view `weekly_stems` の合計から（同じ式） |
| 検算値と確認要否 | 同上 | |
| 積算温度 | `src/lib/gdd.ts` + weather_daily | |
| 収穫予測日、果房重量 | `src/lib/prediction/` → estimates に追記 | |
| 提案 | `src/lib/recommendations/` → recommendations に追記 | |
