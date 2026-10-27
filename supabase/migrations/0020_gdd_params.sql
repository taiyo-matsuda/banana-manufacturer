-- 3-2 積算温度と平年値（prediction.md 1 章）。
--
-- 1. field_cultivar_params（圃場 × 品種の予測パラメータの上書き。0001 で表と RLS fcp_all・org のトリガーは作成済み）:
--    - 範囲の検査: 基準温度 5〜20℃、目標積算温度（出蕾→収穫）100〜5000 ℃・日。null は「品種の既定を使う」
--    - updated_at を更新のたびに now() にする（0017 の set_updated_at()）
--    - 圃場の付け替え（field_id の変更）でほかの組織の圃場に移せないよう、更新でも organization_id を圃場から取り直す
-- 2. weather_hourly_days（ビュー）: 時間別の気温を日本時間の日付ごとに 1 行（気温の配列）にまとめる。
--    茎の画面は出蕾からの期間の時間別を引くが、PostgREST の max_rows（1000 行）に当たらないよう日ごとに束ねて返す
--    （1,000 日まで 1 回の select で取れる）。security_invoker なので weather_hourly の RLS（自組織だけ）がそのまま効く。
--    日付で絞ると集計の前に絞り込まれる（group by の列への条件は下に押し下げられる）。
--
-- 既存の 0001〜0019 は編集しない。

alter table field_cultivar_params
  add constraint field_cultivar_params_base_temp_range check (base_temp_c is null or (base_temp_c >= 5 and base_temp_c <= 20)),
  add constraint field_cultivar_params_target_gdd_range check (
    flowering_to_harvest_gdd is null or (flowering_to_harvest_gdd >= 100 and flowering_to_harvest_gdd <= 5000)
  );

create trigger field_cultivar_params_set_updated_at before update on field_cultivar_params
  for each row execute function set_updated_at();

-- 0001 の set_org_from_field() は insert でだけ動く。field_id を書き換える更新でも圃場の組織を取り直す
-- （RLS の with check で current_org() と比べるので、他組織の圃場への付け替えは拒否される）
create trigger field_cultivar_params_set_org_on_update before update of field_id on field_cultivar_params
  for each row execute function set_org_from_field();

create view weather_hourly_days with (security_invoker = true) as
select
  field_id,
  source,
  (ts at time zone 'Asia/Tokyo')::date as date,
  array_agg(temp_c order by ts) filter (where temp_c is not null) as temps,
  count(*)::int as hours
from weather_hourly
group by field_id, source, (ts at time zone 'Asia/Tokyo')::date;

revoke all on weather_hourly_days from anon;
grant select on weather_hourly_days to authenticated, service_role;
