-- 3-1 の修正（レビュー指摘）。0018 は編集しない。
--
-- 1. weather_sync_status に最後に成功した取り込みの日時と日数を持たせる。
--    全部失敗した回（保存 0 日でエラーあり）でも「最終取得」がその回の日時にならないように、
--    画面の「気温: 最終取得 ◯月◯日 ◯:◯◯（◯日分）」は last_success_at / last_success_days から出す。
--    成功 = エラーがない、または 1 日以上保存できた（一部の失敗は last_error に残る）
-- 2. record_weather_sync() の p_lat / p_lng が null なら、前の座標を残す。
--    代表点の変更を確かめられなかった・前の地点の値を消せなかった回に新しい座標を記録すると、
--    次回は「変更なし」とみなされて前の地点の行が残るため（取り込み側は null を渡す）。

alter table weather_sync_status
  add column last_success_at timestamptz,
  add column last_success_days integer;

update weather_sync_status
  set last_success_at = last_run_at, last_success_days = last_days
  where last_error is null or last_days > 0;

create or replace function record_weather_sync(
  p_field_id uuid,
  p_ran_at timestamptz,
  p_days integer,
  p_error text,
  p_lat double precision,
  p_lng double precision
) returns void
language plpgsql security definer set search_path = public as $$
declare
  succeeded boolean := p_error is null or p_days > 0;
begin
  if not exists (
    select 1 from fields
    where id = p_field_id
      and (organization_id = current_org() or coalesce(auth.role(), '') = 'service_role')
  ) then
    raise exception 'record_weather_sync: 圃場が見つかりません';
  end if;

  insert into weather_sync_status (field_id, last_run_at, last_days, last_error, lat, lng, last_success_at, last_success_days)
  values (
    p_field_id, p_ran_at, p_days, p_error, p_lat, p_lng,
    case when succeeded then p_ran_at end,
    case when succeeded then p_days end
  )
  on conflict (field_id) do update
    set last_run_at = excluded.last_run_at,
        last_days = excluded.last_days,
        last_error = excluded.last_error,
        lat = coalesce(excluded.lat, weather_sync_status.lat),
        lng = coalesce(excluded.lng, weather_sync_status.lng),
        last_success_at = coalesce(excluded.last_success_at, weather_sync_status.last_success_at),
        last_success_days = coalesce(excluded.last_success_days, weather_sync_status.last_success_days);
end;
$$;
