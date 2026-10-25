-- 2-6 の修正: correct_observation（0014）の case v_old.type に else がなく、対象外の種類で
-- 「case not found」（英語）になっていた。else で日本語の例外を出す。0014 は適用済みなので編集せず、ここで置き換える。
-- 本体は 0014 と同じ（security invoker、search_path = public、p_new_id で冪等、訂正済みなら例外）。
create or replace function correct_observation(
  p_new_id uuid,
  p_old_id uuid,
  p_value numeric,
  p_observed_at timestamptz,
  p_note text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_old observations%rowtype;
begin
  if p_new_id is null or p_old_id is null or p_value is null or p_observed_at is null then
    raise exception '訂正する観測、新しい値、日付を指定してください';
  end if;

  -- 冪等: 同じ id の行が既にあれば（再送）何もしない
  if exists (select 1 from observations where id = p_new_id) then
    return p_new_id;
  end if;

  select * into v_old from observations where id = p_old_id for update;
  if not found then
    raise exception '訂正する観測が見つかりません';
  end if;
  if v_old.superseded_by is not null then
    raise exception 'この記録はすでに訂正されています。最新の記録を訂正してください';
  end if;
  if p_observed_at > now() + interval '1 day' then
    raise exception '未来の日付には訂正できません';
  end if;

  case v_old.type
    when 'leaves_new', 'leaves_current' then
      if p_value < 0 or p_value <> trunc(p_value) then
        raise exception '葉の枚数は 0 以上の整数で入力してください';
      end if;
    when 'pseudostem_girth_cm', 'height_cm' then
      if p_value <= 0 then
        raise exception '長さは 0 より大きい数で入力してください';
      end if;
    else
      raise exception 'この種類の観測は訂正できません';
  end case;

  insert into observations (id, stem_id, type, value, observed_at, observed_by, note)
  values (p_new_id, v_old.stem_id, v_old.type, p_value, p_observed_at, auth.uid(), coalesce(p_note, v_old.note));

  update observations set superseded_by = p_new_id where id = p_old_id;

  return p_new_id;
end;
$$;

revoke all on function correct_observation(uuid, uuid, numeric, timestamptz, text) from public;
grant execute on function correct_observation(uuid, uuid, numeric, timestamptz, text) to authenticated;
