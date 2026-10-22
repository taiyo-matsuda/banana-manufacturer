-- E2E 専用組織の掃除。
-- observations / events は追記のみ（RLS に delete ポリシーがなく、stems への FK も cascade ではない）ため、
-- E2E が作った圃場・株・茎は記録が付くとアプリの権限では消せず、実行のたびにテスト農園 A に溜まる。
-- 「追記のみ」は本番の操作に対する原則なので、E2E 専用組織（組織名が「テスト農園」で始まる）の掃除だけを
-- 例外として、組織名で制限した security definer 関数で行う（data-model.md 2.2、architecture.md 7 章）。
--
-- 呼び出し元（current_org()）の組織が「テスト農園」で始まらなければ例外。消すのはその組織の、
-- 名前が prefix で始まる圃場と、その株・茎に紐づく全レコード。戻り値は削除した圃場の数。
create function e2e_cleanup_fields(prefix text) returns integer
language plpgsql security definer set search_path = public as $$
declare
  org uuid := current_org();
  org_name text;
  deleted integer;
begin
  select name into org_name from organizations where id = org;
  if org_name is null or org_name not like 'テスト農園%' then
    raise exception 'e2e_cleanup_fields: E2E 専用組織でのみ実行できます（組織: %）', coalesce(org_name, 'なし');
  end if;

  create temporary table e2e_f on commit drop as
    select id from fields where organization_id = org and name like prefix || '%';
  create temporary table e2e_m on commit drop as
    select id from mats where field_id in (select id from e2e_f);
  create temporary table e2e_s on commit drop as
    select id from stems where mat_id in (select id from e2e_m);
  create temporary table e2e_o on commit drop as
    select id from observations where stem_id in (select id from e2e_s);
  create temporary table e2e_e on commit drop as
    select id from events
    where (target_type = 'stem' and target_id in (select id from e2e_s))
       or (target_type = 'mat' and target_id in (select id from e2e_m))
       or (target_type = 'field' and target_id in (select id from e2e_f));
  create temporary table e2e_p on commit drop as
    select id from photos
    where observation_id in (select id from e2e_o)
       or event_id in (select id from e2e_e)
       or (target_type = 'stem' and target_id in (select id from e2e_s))
       or (target_type = 'mat' and target_id in (select id from e2e_m))
       or (target_type = 'field' and target_id in (select id from e2e_f));

  -- 子 → 親の順。自己参照 FK（superseded_by、parent_stem_id）は 1 文で消せば衝突しない
  update soil_analyses set source_photo_id = null where source_photo_id in (select id from e2e_p);
  delete from photos where id in (select id from e2e_p);
  delete from observations where id in (select id from e2e_o);
  delete from events where id in (select id from e2e_e);
  delete from estimates where stem_id in (select id from e2e_s);
  delete from recommendations
    where (target_type = 'stem' and target_id in (select id from e2e_s))
       or (target_type = 'mat' and target_id in (select id from e2e_m))
       or (target_type = 'field' and target_id in (select id from e2e_f));
  -- 株分け元（mats.origin_stem_id）が消す茎を指していれば外す
  update mats set origin_stem_id = null where origin_stem_id in (select id from e2e_s);
  delete from stems where id in (select id from e2e_s);
  delete from mats where id in (select id from e2e_m);
  delete from fields where id in (select id from e2e_f);
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

revoke all on function e2e_cleanup_fields(text) from public;
grant execute on function e2e_cleanup_fields(text) to authenticated;
