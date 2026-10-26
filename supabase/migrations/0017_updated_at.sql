-- 2-9 読み取りのローカルキャッシュ（offline-sync.md 5.2）。
-- 端末のキャッシュ（Dexie）が差分だけを取り込めるよう、キャッシュする 6 表に updated_at を持たせる。
--
-- - updated_at timestamptz not null default now()（既存の行は now() で埋まる）
-- - 更新のたびに now() を入れる BEFORE UPDATE トリガー（共通関数 set_updated_at()）。
--   アプリが updated_at を直接書いても、このトリガーが now() で上書きする
-- - 差分の取得（updated_at > カーソル、order by updated_at, id）のための (organization_id, updated_at) の索引
--
-- 追記のみの検査（0001 の forbid_update_except_supersede）との関係:
-- 0001 の関数は superseded_by 以外の列の変化を拒否するので、そのままでは updated_at の自動更新と衝突する。
-- 比較から superseded_by と updated_at の両方を除く形に差し替える。それ以外の列の変更は引き続き拒否する。
-- 同じ表の BEFORE トリガーは名前のアルファベット順に動く（*_append_only → *_set_updated_at）。
-- 検査は updated_at を比較から除くので、どちらが先でも結果は同じ。
--
-- 訂正（2-6、0014）で元の観測・イベントの superseded_by が更新されると updated_at が変わり、差分同期で端末に届く。
-- 既存の 0001〜0016 は編集しない。

create or replace function forbid_update_except_supersede() returns trigger language plpgsql as $$
begin
  if to_jsonb(new) - 'superseded_by' - 'updated_at' <> to_jsonb(old) - 'superseded_by' - 'updated_at' then
    raise exception 'append-only table: only superseded_by can be updated';
  end if;
  return new;
end $$;

create function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

alter table fields add column updated_at timestamptz not null default now();
alter table mats add column updated_at timestamptz not null default now();
alter table stems add column updated_at timestamptz not null default now();
alter table observations add column updated_at timestamptz not null default now();
alter table events add column updated_at timestamptz not null default now();
alter table photos add column updated_at timestamptz not null default now();

create trigger fields_set_updated_at before update on fields for each row execute function set_updated_at();
create trigger mats_set_updated_at before update on mats for each row execute function set_updated_at();
create trigger stems_set_updated_at before update on stems for each row execute function set_updated_at();
create trigger observations_set_updated_at before update on observations for each row execute function set_updated_at();
create trigger events_set_updated_at before update on events for each row execute function set_updated_at();
create trigger photos_set_updated_at before update on photos for each row execute function set_updated_at();

create index fields_org_updated_idx on fields (organization_id, updated_at);
create index mats_org_updated_idx on mats (organization_id, updated_at);
create index stems_org_updated_idx on stems (organization_id, updated_at);
create index observations_org_updated_idx on observations (organization_id, updated_at);
create index events_org_updated_idx on events (organization_id, updated_at);
create index photos_org_updated_idx on photos (organization_id, updated_at);
