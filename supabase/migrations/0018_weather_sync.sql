-- 3-1 気温の取り込み（prediction.md 1 章、architecture.md 5 章、data-model.md weather_hourly / weather_daily）。
--
-- 1. weather_hourly / weather_daily に列を足す（0001 の主キー (field_id, ts|date, source) はそのまま）
--    - api: Open-Meteo のどの API の値か。'forecast'（予報 API の past_days。直近の暫定値）/ 'archive'（過去 API の確定値）。
--      1 日 1 行（source = 'open-meteo'）で、予報 API の暫定値を後日 過去 API の確定値で upsert して上書きする。
--      api = 'forecast' の行は「まだ確定していない」印で、確定値が出る日数（5 日）を過ぎたら過去 API で取り直す。
--    - temperature_offset_c: 保存した気温に加えた圃場の補正（fields.temperature_offset_c、取得時の値）。
--      保存値 = Open-Meteo の値 + この補正。補正が変わったら、値の違う行を取り直す。
--    - fetched_at: 取得した日時
--    - weather_daily.wind_max_ms: 時間別の風速（10m）の日最大
-- 2. weather_sync_status: 圃場ごとの取り込みの記録（最終実行・件数・最後のエラー・使った座標）。
--    RLS は自組織の select のみ。書き込みは record_weather_sync()（security definer）だけ。
-- 3. record_weather_sync(): 取り込みの記録を書く。呼べるのは、その圃場の組織のユーザー（登録時・手動の取り込み）か
--    service_role（Cron の Route Handler。architecture.md 2・7 章の例外）だけ。
--
-- 圃場を消すと weather_* と weather_sync_status は on delete cascade で消える（E2E の掃除 0006 も fields を消すので同じ）。
-- 既存の 0001〜0017 は編集しない。

alter table weather_daily
  add column api text not null default 'archive' check (api in ('forecast', 'archive')),
  add column temperature_offset_c numeric(3,1) not null default 0,
  add column wind_max_ms numeric(4,1),
  add column fetched_at timestamptz not null default now();

alter table weather_hourly
  add column api text not null default 'archive' check (api in ('forecast', 'archive')),
  add column temperature_offset_c numeric(3,1) not null default 0,
  add column fetched_at timestamptz not null default now();

create table weather_sync_status (
  field_id uuid primary key references fields (id) on delete cascade,
  organization_id uuid not null references organizations (id),
  last_run_at timestamptz not null,          -- 最後に取り込みを実行した日時
  last_days integer not null default 0,      -- その回に保存した日別の行数
  last_error text,                           -- その回のエラー（なければ null）
  lat double precision,                      -- その回に使った座標（代表点が変わったら取り直す）
  lng double precision,
  updated_at timestamptz not null default now()
);

create trigger weather_sync_status_set_org before insert on weather_sync_status
  for each row execute function set_org_from_field();
create trigger weather_sync_status_set_updated_at before update on weather_sync_status
  for each row execute function set_updated_at();

alter table weather_sync_status enable row level security;
create policy weather_sync_status_read on weather_sync_status for select using (organization_id = current_org());

create function record_weather_sync(
  p_field_id uuid,
  p_ran_at timestamptz,
  p_days integer,
  p_error text,
  p_lat double precision,
  p_lng double precision
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from fields
    where id = p_field_id
      and (organization_id = current_org() or coalesce(auth.role(), '') = 'service_role')
  ) then
    raise exception 'record_weather_sync: 圃場が見つかりません';
  end if;

  insert into weather_sync_status (field_id, last_run_at, last_days, last_error, lat, lng)
  values (p_field_id, p_ran_at, p_days, p_error, p_lat, p_lng)
  on conflict (field_id) do update
    set last_run_at = excluded.last_run_at,
        last_days = excluded.last_days,
        last_error = excluded.last_error,
        lat = excluded.lat,
        lng = excluded.lng;
end;
$$;

revoke all on function record_weather_sync(uuid, timestamptz, integer, text, double precision, double precision) from public;
grant execute on function record_weather_sync(uuid, timestamptz, integer, text, double precision, double precision)
  to authenticated, service_role;
