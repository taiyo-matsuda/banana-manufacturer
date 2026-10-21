# 設計: 予測と提案

最終更新: 2026-10-21　要件: `../01_requirements.md` 7章　実装: `src/lib/gdd.ts`, `src/lib/prediction/`, `src/lib/recommendations/`

すべて UI に依存しない純粋関数として書き、単体テストを付ける。結果は `estimates` / `recommendations` に追記する。

---

## 1. 積算温度（GDD）

- 入力: `weather_daily`（圃場ごと）、基準温度 `base_temp_c`（品種、圃場×品種で上書き可。既定 14℃）
- 日次 GDD = max(0, t_mean − base_temp)
  - `weather_hourly` があるときは、時間別に max(0, temp − base) を平均した値を使う（冬の日較差が大きい日に精度が上がる）
- 期間の積算 = 開始日の翌日から終了日までの日次 GDD の合計
- 将来の積算は「平年値」を使う。平年値 = 過去データ（Open-Meteo の過去 API で取れる範囲、最低3年）の同じ日の平均。データが足りない間は沖縄の月別平年気温をマスタとして持つ

## 2. 収穫予測日（`harvest_date`、MVP）

- 対象: `status = flowered` の茎
- 入力: 出蕾日（`bud_emerged_at`）、目標 GDD（`flowering_to_harvest_gdd`。品種、圃場×品種で上書き可。既定 900）
- 計算:
  1. 出蕾日から今日までの実績 GDD を積算
  2. 残り = 目標 − 実績
  3. 明日以降、平年値で積算して残りに達する日 = 予測日
- 幅: 目標 GDD の ±10% で lower / upper を出す（実績が溜まったら、圃場×季節の実績の分散から決める）
- 再計算: 気象の日次更新後、および出蕾イベントの記録時
- `inputs` に出蕾日、目標 GDD、実績 GDD、使った平年値のバージョンを残す
- 出蕾日に幅（`earliest_at`）がある場合は、確認日を使い、`inputs` に幅を残す（MVP ではそれ以上扱わない）

### 補正
収穫実績が溜まったら、圃場×品種ごとに「出蕾→収穫の実績 GDD」の中央値を `field_cultivar_params.flowering_to_harvest_gdd` として提案する（自動で書き換えず、設定画面で採用する）。

## 3. 果房重量（`bunch_weight_kg`、MVP。実績が溜まってから有効化）

- 対象: `flowered` の茎（出蕾時の記録があるもの）
- 入力: 出蕾時の偽茎周囲長、生葉数、段数、出蕾月
- モデル: 最初は線形回帰（周囲長、生葉数、段数、季節ダミー）。実績 20 房未満なら計算しない（「未算出」）
- 幅: 回帰の残差の標準偏差で lower / upper
- 学習データ: `harvested` イベントの `weight_kg` と、その茎の出蕾時の記録。組織内のデータだけを使う（将来、品種が同じなら組織横断も検討）
- `model_version` に「linear-v1 / 学習に使った房数 / 学習日」を入れる

## 4. 累計葉数の推定（`cumulative_leaves`、補助）

- 訪問できなかった期間（前回の `leaves_new` から 21 日以上）がある茎に対して、「GDD あたりの出葉速度」から推定値を出す
- 出葉速度 = その圃場の実績（leaves_new の合計 ÷ 同期間の GDD）。実績がない間は文献値（暖期で 7〜10 日に1枚相当）
- 推定値は観測と併存させ、画面では「推定」と明示する。累計葉数の正式な値は観測のみから計算する

## 5. 出蕾予測（`bud_date`、MVP 外）

- 累計葉数と `leaves_to_flowering` の差 ÷ 出葉速度 → 日数 → 平年値で日付化
- `leaves_to_flowering` は1作目の出蕾実績から圃場×品種で決める。それまでは計算しない

## 6. 提案ルール

実行タイミング: イベント記録時、および日次バッチ。同じ対象・同じ kind で `open` があれば作らない。

| kind | 条件 | due_at | reason |
|---|---|---|---|
| `bag` | `bud_emerged` から N 日経過（N は設定。初期値は要確認）で `bagged` がない | 出蕾日 + N | 「出蕾から N 日」 |
| `debud` | 同上（袋掛けと同時に提案） | 同上 | |
| `harvest_window` | `harvest_date` の lower が 7 日以内 | lower | 「積算温度が目安に到達」 |
| `fertilize_after_harvest` | `harvested` が記録され、その株に M 日以内の `fertilized` がない | 収穫日 + M | 「収穫後の追肥」。量は圃場標準＋株差分 |
| `remove_dead_leaves` | 最後の `leaves_removed` から X 日以上、かつ茎が active / flowered | 今日 | |
| `inspect` | 累計葉数の検算ずれ ≥ 3、または `damage` の severity が severe / lost | 今日 | ずれの枚数、被害の内容 |

- 対象が `lost` / `harvested` / `removed` / `transplanted` になった茎の `open` な提案は自動で `dismissed` にする（reason に「対象が終了」）
- 「実施した」= `done`、「無視」= `dismissed`。どちらも `resolved_at` / `resolved_by` を残す

## 7. 被害による予測の見直し

- `damage` の severity が `lost` → 茎を `lost` にし、推定を出さない。週次の出荷見込みから外す
- `severe` → 推定は出すが「要確認」フラグ（`inputs.damage = severe`）。週次見込みでは「不確実」として別枠で数える
- `moderate` / `light` → 変更なし（将来、実績から重量への影響を推定する）

## 8. 週ごとの出荷見込み

- 対象: `flowered` の茎で `harvest_date` の最新推定があるもの（`lost` を除く）
- 週 = 月曜始まり。予測日の value_date が入る週に本数を数える
- 見込み kg = その週の茎の `bunch_weight_kg` の合計（未算出の茎は本数のみ）
- 「不確実」= severe の被害がある茎、または lower〜upper が 3 週以上にまたがる茎。別枠で表示
- 将来の販売アプリは、この集計を API で返す
