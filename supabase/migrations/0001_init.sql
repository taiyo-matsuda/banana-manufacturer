-- バナナ生育記録・収穫予測システム 初期スキーマ
-- 設計: docs/02_design/data-model.md
--
-- 方針
-- - 全テーブルに organization_id を持つ（意図的な非正規化。RLS を1条件にするため）
--   子テーブルの organization_id は INSERT トリガーで親からコピーする。アプリからは渡さない。
-- - observations / events は追記のみ（UPDATE / DELETE を RLS で許可しない）
-- - 座標は lat / lng の数値列で持つ（MVP では PostGIS を使わない。必要になったら移行）

create extension if not exists "pgcrypto";

-- =============================================================================
-- 列挙型
-- =============================================================================

create type mat_origin_type as enum ('tissue_culture', 'sucker_purchased', 'sucker_transplant');
create type mat_status as enum ('active', 'removed');
create type stem_status as enum ('sucker', 'active', 'flowered', 'harvested', 'removed', 'transplanted', 'lost');
create type observation_type as enum ('leaves_new', 'leaves_current', 'pseudostem_girth_cm', 'height_cm');
create type event_type as enum (
  'bud_emerged', 'hands_counted', 'bagged', 'debudded', 'harvested',
  'leaves_removed', 'fertilized', 'damage',
  'sucker_emerged', 'sucker_adopted', 'sucker_removed', 'sucker_transplanted',
  'stem_removed', 'mat_removed'
);
create type target_type as enum ('stem', 'mat', 'field');
create type photo_kind as enum ('side', 'bud', 'bunch', 'damage', 'other');
create type upload_status as enum ('local', 'uploaded');
create type estimate_kind as enum ('harvest_date', 'bunch_weight_kg', 'cumulative_leaves', 'bud_date');
create type recommendation_kind as enum ('bag', 'debud', 'harvest_window', 'fertilize_after_harvest', 'remove_dead_leaves', 'inspect');
create type recommendation_status as enum ('open', 'done', 'dismissed');
create type weather_source as enum ('open-meteo', 'amedas', 'logger');

-- =============================================================================
-- 組織・ユーザー
-- =============================================================================

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- auth.users と 1:1。組織への所属を持つ
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  organization_id uuid not null references organizations (id),
  display_name text not null,
  role text not null default 'owner',
  created_at timestamptz not null default now()
);

-- ログイン中ユーザーの組織。RLS ポリシーで使う
create function current_org() returns uuid
language sql stable security definer set search_path = public as $$
  select organization_id from profiles where id = auth.uid()
$$;

-- =============================================================================
-- マスタ
-- =============================================================================

-- 品種マスタ。全組織で共有（organization_id なし）
create table cultivars (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  base_temp_c numeric(4,1) not null default 14.0,
  flowering_to_harvest_gdd numeric(6,1) not null default 900.0,
  leaves_to_flowering integer,
  created_at timestamptz not null default now()
);

insert into cultivars (name) values ('ドワーフナムワ');

-- =============================================================================
-- 圃場
-- =============================================================================

create table fields (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  name text not null,
  center_lat double precision not null,
  center_lng double precision not null,
  notes text,
  -- 以下は後回し（列だけ用意）
  boundary jsonb,                        -- GeoJSON Polygon。筆ポリゴンから取り込む
  weather_lat double precision,          -- 空なら center を使う
  weather_lng double precision,
  temperature_offset_c numeric(3,1) not null default 0,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

-- 圃場 × 品種ごとの予測パラメータの上書き
create table field_cultivar_params (
  field_id uuid not null references fields (id) on delete cascade,
  cultivar_id uuid not null references cultivars (id),
  organization_id uuid not null references organizations (id),
  base_temp_c numeric(4,1),
  flowering_to_harvest_gdd numeric(6,1),
  leaves_to_flowering integer,
  updated_at timestamptz not null default now(),
  primary key (field_id, cultivar_id)
);

-- 土壌分析（圃場単位。採取地点は持たない）
create table soil_analyses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  field_id uuid not null references fields (id) on delete cascade,
  sampled_at date not null,
  source_photo_id uuid,                  -- photos.id（後で FK を張る）
  note text,
  created_at timestamptz not null default now()
);

create table soil_analysis_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  soil_analysis_id uuid not null references soil_analyses (id) on delete cascade,
  item text not null,                    -- 'pH', 'EC', 'CEC', 'OM', 'N', 'P', 'K', 'Ca', 'Mg' など
  value numeric not null,
  unit text,
  unique (soil_analysis_id, item)
);

-- =============================================================================
-- 株・茎
-- =============================================================================

create table mats (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  field_id uuid not null references fields (id),
  code text not null,                    -- 例 'A-012'
  cultivar_id uuid not null references cultivars (id),
  lat double precision not null,
  lng double precision not null,
  planted_at date not null,
  origin_type mat_origin_type not null,
  origin_stem_id uuid,                   -- stems.id（株分け元。後で FK を張る）
  status mat_status not null default 'active',
  created_at timestamptz not null default now(),
  unique (field_id, code)
);

create table stems (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  mat_id uuid not null references mats (id),
  generation integer not null check (generation >= 1),
  parent_stem_id uuid references stems (id),
  status stem_status not null default 'sucker',
  started_at date not null,
  adopted_at date,
  initial_leaf_count integer not null default 0 check (initial_leaf_count >= 0),
  first_broad_leaf_at date,
  -- イベントから更新される冗長項目（検索用）
  bud_emerged_at date,
  bagged_at date,
  harvested_at date,
  ended_at date,
  created_at timestamptz not null default now()
);

alter table mats add constraint mats_origin_stem_fk
  foreign key (origin_stem_id) references stems (id);

create index stems_mat_idx on stems (mat_id);
create index stems_status_idx on stems (organization_id, status);

-- =============================================================================
-- 観測・イベント・写真（追記のみ）
-- =============================================================================

create table observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  stem_id uuid not null references stems (id),
  type observation_type not null,
  value numeric not null,
  observed_at timestamptz not null,
  observed_by uuid references profiles (id),
  note text,
  superseded_by uuid references observations (id),
  created_at timestamptz not null default now()
);

create index observations_stem_idx on observations (stem_id, observed_at);

create table events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  type event_type not null,
  target_type target_type not null,
  target_id uuid not null,
  occurred_at timestamptz not null,
  recorded_by uuid references profiles (id),
  payload jsonb not null default '{}'::jsonb,
  note text,
  superseded_by uuid references events (id),
  created_at timestamptz not null default now()
);

create index events_target_idx on events (target_type, target_id, occurred_at);
create index events_type_idx on events (organization_id, type, occurred_at);

create table photos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  storage_path text not null unique,
  taken_at timestamptz not null,
  taken_by uuid references profiles (id),
  lat double precision,
  lng double precision,
  target_type target_type not null,
  target_id uuid not null,
  observation_id uuid references observations (id),
  event_id uuid references events (id),
  kind photo_kind not null default 'other',
  upload_status upload_status not null default 'uploaded',
  created_at timestamptz not null default now()
);

create index photos_target_idx on photos (target_type, target_id, taken_at);

alter table soil_analyses add constraint soil_analyses_source_photo_fk
  foreign key (source_photo_id) references photos (id);

-- =============================================================================
-- 気象（圃場単位）
-- =============================================================================

create table weather_hourly (
  organization_id uuid not null references organizations (id),
  field_id uuid not null references fields (id) on delete cascade,
  ts timestamptz not null,
  temp_c numeric(4,1),
  precip_mm numeric(5,1),
  wind_max_ms numeric(4,1),
  source weather_source not null default 'open-meteo',
  primary key (field_id, ts, source)
);

create table weather_daily (
  organization_id uuid not null references organizations (id),
  field_id uuid not null references fields (id) on delete cascade,
  date date not null,
  t_mean numeric(4,1),
  t_min numeric(4,1),
  t_max numeric(4,1),
  precip_mm numeric(5,1),
  gdd numeric(5,2),                      -- base_temp は品種ごとに違うため、再計算用に t_mean も保持
  source weather_source not null default 'open-meteo',
  primary key (field_id, date, source)
);

-- =============================================================================
-- 推定・提案
-- =============================================================================

create table estimates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  stem_id uuid not null references stems (id),
  kind estimate_kind not null,
  value numeric,                         -- harvest_date は日付を epoch day などで持たず、value_date を使う
  value_date date,
  lower numeric,
  upper numeric,
  lower_date date,
  upper_date date,
  model_version text not null,
  inputs jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now()
);

create index estimates_stem_idx on estimates (stem_id, kind, computed_at desc);

create table recommendations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  kind recommendation_kind not null,
  target_type target_type not null,
  target_id uuid not null,
  due_at date,
  reason text,
  status recommendation_status not null default 'open',
  resolved_at timestamptz,
  resolved_by uuid references profiles (id),
  created_at timestamptz not null default now()
);

create index recommendations_open_idx on recommendations (organization_id, status, due_at);

-- =============================================================================
-- organization_id を親からコピーするトリガー
-- =============================================================================

create function set_org_from_field() returns trigger language plpgsql as $$
begin
  select organization_id into new.organization_id from fields where id = new.field_id;
  return new;
end $$;

create function set_org_from_mat() returns trigger language plpgsql as $$
begin
  select organization_id into new.organization_id from mats where id = new.mat_id;
  return new;
end $$;

create function set_org_from_stem() returns trigger language plpgsql as $$
begin
  select organization_id into new.organization_id from stems where id = new.stem_id;
  return new;
end $$;

create function set_org_from_soil_analysis() returns trigger language plpgsql as $$
begin
  select organization_id into new.organization_id from soil_analyses where id = new.soil_analysis_id;
  return new;
end $$;

-- target_type / target_id で親が変わるもの
create function set_org_from_target() returns trigger language plpgsql as $$
begin
  if new.target_type = 'stem' then
    select organization_id into new.organization_id from stems where id = new.target_id;
  elsif new.target_type = 'mat' then
    select organization_id into new.organization_id from mats where id = new.target_id;
  else
    select organization_id into new.organization_id from fields where id = new.target_id;
  end if;
  if new.organization_id is null then
    raise exception 'target % % not found', new.target_type, new.target_id;
  end if;
  return new;
end $$;

create trigger mats_set_org before insert on mats for each row execute function set_org_from_field();
create trigger field_cultivar_params_set_org before insert on field_cultivar_params for each row execute function set_org_from_field();
create trigger soil_analyses_set_org before insert on soil_analyses for each row execute function set_org_from_field();
create trigger weather_hourly_set_org before insert on weather_hourly for each row execute function set_org_from_field();
create trigger weather_daily_set_org before insert on weather_daily for each row execute function set_org_from_field();
create trigger soil_analysis_items_set_org before insert on soil_analysis_items for each row execute function set_org_from_soil_analysis();
create trigger stems_set_org before insert on stems for each row execute function set_org_from_mat();
create trigger observations_set_org before insert on observations for each row execute function set_org_from_stem();
create trigger estimates_set_org before insert on estimates for each row execute function set_org_from_stem();
create trigger events_set_org before insert on events for each row execute function set_org_from_target();
create trigger photos_set_org before insert on photos for each row execute function set_org_from_target();
create trigger recommendations_set_org before insert on recommendations for each row execute function set_org_from_target();

-- =============================================================================
-- 株ごとに栽培中の茎は最大3本
-- =============================================================================

create function check_max_active_stems() returns trigger language plpgsql as $$
declare
  n integer;
begin
  if new.status in ('active', 'flowered') then
    select count(*) into n from stems
      where mat_id = new.mat_id and id <> new.id and status in ('active', 'flowered');
    if n >= 3 then
      raise exception 'mat % already has 3 active stems', new.mat_id;
    end if;
  end if;
  return new;
end $$;

create trigger stems_max_active before insert or update of status on stems
  for each row execute function check_max_active_stems();

-- =============================================================================
-- RLS
-- =============================================================================

alter table organizations enable row level security;
alter table profiles enable row level security;
alter table cultivars enable row level security;
alter table fields enable row level security;
alter table field_cultivar_params enable row level security;
alter table soil_analyses enable row level security;
alter table soil_analysis_items enable row level security;
alter table mats enable row level security;
alter table stems enable row level security;
alter table observations enable row level security;
alter table events enable row level security;
alter table photos enable row level security;
alter table weather_hourly enable row level security;
alter table weather_daily enable row level security;
alter table estimates enable row level security;
alter table recommendations enable row level security;

create policy org_read on organizations for select using (id = current_org());
create policy profile_read on profiles for select using (organization_id = current_org());
create policy cultivar_read on cultivars for select using (true);

-- 通常のテーブル: 自組織の行を読み書きできる
create policy fields_all on fields for all using (organization_id = current_org()) with check (organization_id = current_org());
create policy fcp_all on field_cultivar_params for all using (organization_id = current_org()) with check (organization_id = current_org());
create policy soil_all on soil_analyses for all using (organization_id = current_org()) with check (organization_id = current_org());
create policy soil_items_all on soil_analysis_items for all using (organization_id = current_org()) with check (organization_id = current_org());
create policy mats_all on mats for all using (organization_id = current_org()) with check (organization_id = current_org());
create policy stems_all on stems for all using (organization_id = current_org()) with check (organization_id = current_org());
create policy weather_hourly_all on weather_hourly for all using (organization_id = current_org()) with check (organization_id = current_org());
create policy weather_daily_all on weather_daily for all using (organization_id = current_org()) with check (organization_id = current_org());
create policy estimates_all on estimates for all using (organization_id = current_org()) with check (organization_id = current_org());
create policy recommendations_all on recommendations for all using (organization_id = current_org()) with check (organization_id = current_org());

-- 追記のみのテーブル: select と insert のみ。訂正は superseded_by を持つ新レコードで行う
-- （superseded_by を元レコードに書く必要があるため、その列だけ update を許可する）
create policy observations_read on observations for select using (organization_id = current_org());
create policy observations_insert on observations for insert with check (organization_id = current_org());
create policy observations_supersede on observations for update using (organization_id = current_org()) with check (organization_id = current_org());

create policy events_read on events for select using (organization_id = current_org());
create policy events_insert on events for insert with check (organization_id = current_org());
create policy events_supersede on events for update using (organization_id = current_org()) with check (organization_id = current_org());

create policy photos_read on photos for select using (organization_id = current_org());
create policy photos_insert on photos for insert with check (organization_id = current_org());
create policy photos_update on photos for update using (organization_id = current_org()) with check (organization_id = current_org());

-- 追記のみテーブルは superseded_by 以外の更新を禁止する
create function forbid_update_except_supersede() returns trigger language plpgsql as $$
begin
  if to_jsonb(new) - 'superseded_by' <> to_jsonb(old) - 'superseded_by' then
    raise exception 'append-only table: only superseded_by can be updated';
  end if;
  return new;
end $$;

create trigger observations_append_only before update on observations for each row execute function forbid_update_except_supersede();
create trigger events_append_only before update on events for each row execute function forbid_update_except_supersede();
