-- 3-5 収穫後の追肥・枯葉処理・確認の提案（prediction.md 6 章、data-model.md field_recommendation_params）。
--
-- ルールは src/lib/recommendations/rules.ts（純粋関数）、DB への反映は src/lib/recommendations/recompute.ts。
-- recommendations の表（rule_key・unique・トリガー・RLS）は 0022 のまま使う（株が対象の提案は target_type = 'mat'）。
--
-- 1. field_recommendation_params に圃場ごとの設定を足す（空なら暫定の既定値。01_requirements.md 10 章）
--    - fertilize_after_harvest_days: 収穫後の追肥の期限 M（収穫から M 日）。1〜60、空なら 7
--    - dead_leaves_interval_days: 枯葉処理の間隔 X（最後の枯葉処理、なければ採用・植え付けから）。1〜365、空なら 30
--    - fertilizer_standard_amount / fertilizer_standard_unit: 追肥の圃場の標準量（既定値は置かない。肥料により違うため）。
--      量と単位は両方そろうか、両方空。量は施肥の一括入力（2-4）と同じ範囲（0 より大きく 100000 以下）、単位も同じ 4 種
-- 2. weekly_stems（0016）を service_role でも読めるようにする（日次の Cron の提案の評価が検算の Σ新葉に使う）
--
-- 既存の 0001〜0022 は編集しない。

alter table field_recommendation_params
  add column fertilize_after_harvest_days integer
    check (fertilize_after_harvest_days is null or (fertilize_after_harvest_days >= 1 and fertilize_after_harvest_days <= 60)),
  add column dead_leaves_interval_days integer
    check (dead_leaves_interval_days is null or (dead_leaves_interval_days >= 1 and dead_leaves_interval_days <= 365)),
  add column fertilizer_standard_amount numeric
    check (fertilizer_standard_amount is null or (fertilizer_standard_amount > 0 and fertilizer_standard_amount <= 100000)),
  add column fertilizer_standard_unit text
    check (fertilizer_standard_unit is null or fertilizer_standard_unit in ('kg', 'g', 'L', 'mL')),
  add constraint field_recommendation_params_standard_amount
    check ((fertilizer_standard_amount is null) = (fertilizer_standard_unit is null));

grant select on weekly_stems to service_role;
