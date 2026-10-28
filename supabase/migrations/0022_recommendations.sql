-- 3-4 提案の基盤と、袋掛け・摘蕾・収穫期（prediction.md 6 章、data-model.md recommendations）。
--
-- 提案（recommendations）は観測・推定と分けた 3 層目。ルールは src/lib/recommendations/（純粋関数）、DB への反映は
-- src/lib/recommendations/recompute.ts（収穫予測日の再計算と同じ入口で走る）。
--
-- 1. recommendations に列を足す
--    - rule_key: 同じ対象・同じ kind の中で「どの出来事に対する提案か」の鍵。袋掛け・摘蕾・収穫期は茎ごとに 1 回なので ''。
--      3-5 の収穫後の追肥（同じ株で収穫のたびに出る）などは収穫のイベント id などを入れる
--    - resolution_note: 閉じた理由（「無視」「対象が終了」や、done にしたイベントの種類）
--    - resolved_event_id: done にした（または終了の原因になった）イベント（events.id）
-- 2. 二重の防止
--    - unique (target_type, target_id, kind, rule_key): 状態に関係なく 1 行。「無視」（dismissed）した提案は再び作られない
--      （アプリは on conflict do nothing で追記する）
--    - 部分 unique index（status = 'open'）: 同じ対象・同じ kind で open は 1 つまで（rule_key が違っても）
-- 3. 書き換えの制限（トリガー）: 追記は status = 'open'・resolved_* 空のときだけ。更新は open → done / dismissed の 1 回だけで、
--    変えられるのは status と resolved_at / resolved_by / resolution_note / resolved_event_id だけ。
--    resolved_at は now()、resolved_by は渡されなければ auth.uid()（Cron の service_role では null のまま）。
--    resolved_by は同じ組織のユーザーでなければ拒否する
-- 4. RLS: 0001 の recommendations_all（for all）を select / insert / update に置き換える（delete はしない。
--    E2E の掃除 0006 は security definer なので影響しない）
-- 5. field_recommendation_params（圃場ごとの提案の設定）: 袋掛け・摘蕾の日数 N（1〜60、空なら 14）と収穫期の日数（0〜30、空なら 7）。
--    3-5 で追肥・枯葉処理の列を足す。organization_id は圃場からトリガーでコピー
-- 6. open_recommendations（ビュー、security_invoker）: open の提案に対象の茎・株・圃場の表示項目を付ける（ホームの「提案」）
--
-- 既存の 0001〜0021 は編集しない。

alter table recommendations
  add column rule_key text not null default '',
  add column resolution_note text,
  add column resolved_event_id uuid; -- events.id。FK は張らない（E2E の掃除 0006 は events を recommendations より先に消す）

alter table recommendations
  add constraint recommendations_once unique (target_type, target_id, kind, rule_key),
  add constraint recommendations_resolution check (
    (status = 'open' and resolved_at is null and resolved_by is null and resolved_event_id is null and resolution_note is null)
    or (status <> 'open' and resolved_at is not null)
  );

create unique index recommendations_one_open on recommendations (target_type, target_id, kind) where status = 'open';
create index recommendations_target_idx on recommendations (target_type, target_id);

create function guard_recommendation_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'open' or new.resolved_at is not null or new.resolved_by is not null
       or new.resolved_event_id is not null or new.resolution_note is not null then
      raise exception '提案は未対応（open）として追加してください';
    end if;
    return new;
  end if;

  -- UPDATE
  if old.status <> 'open' then
    raise exception 'この提案はすでに閉じています';
  end if;
  if new.status not in ('done', 'dismissed') then
    raise exception '提案は「実施した」か「無視」でだけ閉じられます';
  end if;
  if new.organization_id <> old.organization_id or new.kind <> old.kind or new.target_type <> old.target_type
     or new.target_id <> old.target_id or new.rule_key <> old.rule_key
     or new.due_at is distinct from old.due_at or new.reason is distinct from old.reason
     or new.created_at <> old.created_at then
    raise exception '提案の中身は変えられません';
  end if;
  new.resolved_at := now();
  new.resolved_by := coalesce(new.resolved_by, auth.uid());
  if new.resolved_by is not null then
    select organization_id into v_org from profiles where id = new.resolved_by;
    if v_org is distinct from old.organization_id then
      raise exception '提案を閉じたユーザーが組織に見つかりません';
    end if;
  end if;
  return new;
end $$;

create trigger recommendations_guard before insert or update on recommendations
  for each row execute function guard_recommendation_write();

drop policy recommendations_all on recommendations;
create policy recommendations_read on recommendations for select using (organization_id = current_org());
create policy recommendations_insert on recommendations for insert with check (organization_id = current_org());
create policy recommendations_resolve on recommendations for update using (organization_id = current_org()) with check (organization_id = current_org());

-- 圃場ごとの提案の設定
create table field_recommendation_params (
  field_id uuid primary key references fields (id) on delete cascade,
  organization_id uuid not null references organizations (id),
  bag_after_days integer check (bag_after_days is null or (bag_after_days >= 1 and bag_after_days <= 60)),
  harvest_window_days integer check (harvest_window_days is null or (harvest_window_days >= 0 and harvest_window_days <= 30)),
  updated_at timestamptz not null default now()
);

create trigger field_recommendation_params_set_org before insert on field_recommendation_params
  for each row execute function set_org_from_field();
create trigger field_recommendation_params_set_org_on_update before update of field_id on field_recommendation_params
  for each row execute function set_org_from_field();
create trigger field_recommendation_params_set_updated_at before update on field_recommendation_params
  for each row execute function set_updated_at();

alter table field_recommendation_params enable row level security;
create policy frp_all on field_recommendation_params for all using (organization_id = current_org()) with check (organization_id = current_org());

-- ホームの「提案」: open の提案と対象の表示項目（茎 → 株 → 圃場。対象が株・圃場の提案（3-5）は茎の列が null）
create view open_recommendations with (security_invoker = true) as
select
  r.id,
  r.organization_id,
  r.kind,
  r.target_type,
  r.target_id,
  r.rule_key,
  r.due_at,
  r.reason,
  r.created_at,
  s.id as stem_id,
  s.generation,
  s.status as stem_status,
  m.id as mat_id,
  m.code as mat_code,
  f.id as field_id,
  f.name as field_name
from recommendations r
left join stems s on r.target_type = 'stem' and s.id = r.target_id
left join mats m on m.id = coalesce(s.mat_id, case when r.target_type = 'mat' then r.target_id end)
left join fields f on f.id = coalesce(m.field_id, case when r.target_type = 'field' then r.target_id end)
where r.status = 'open';

revoke all on open_recommendations from anon;
grant select on open_recommendations to authenticated, service_role;
