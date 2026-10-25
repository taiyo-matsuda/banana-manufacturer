-- 2-6 記録の訂正（要件 5.5、data-model 2.2）。
-- 観測・イベントは追記のみ。訂正は「新しい行を追加し、元の行の superseded_by に新しい行の id を入れる」で行う
-- （0001 の forbid_update_except_supersede が superseded_by 以外の更新を拒否し、observations_supersede /
--  events_supersede の RLS が自組織の行の update を許す）。2 つの書き込みを 1 トランザクションにするため RPC にする。
--
-- 共通の約束:
-- - security invoker（RLS がそのまま効く。他組織の行は見えず「見つかりません」）
-- - p_new_id（端末が採番した新しい行の id）で冪等。その id の行が既にあれば何もせず p_new_id を返す（応答が届かなかった再送）
-- - 元の行が既に訂正済み（superseded_by is not null）なら例外。最新の行（訂正で追加された行）は訂正できる
-- - organization_id は渡さない（INSERT トリガーが親からコピーする）
-- - p_note が null なら元の行の note を引き継ぐ
-- - 訂正できる項目・入力の検査は src/lib/corrections.ts と同じ表。片方を変えたら両方を変える
--
-- correct_stem_event で訂正できるイベントと、茎の日付列の更新:
--
--   | type            | 訂正できる payload                         | stems の更新（新しい日付）  |
--   |-----------------|--------------------------------------------|-----------------------------|
--   | bud_emerged     | leaves_current, girth_cm, earliest_at      | bud_emerged_at              |
--   | hands_counted   | hands                                      | なし                        |
--   | bagged          | なし（日付だけ）                           | bagged_at                   |
--   | debudded        | なし（日付だけ）                           | なし                        |
--   | harvested       | weight_kg                                  | harvested_at, ended_at      |
--   | leaves_removed  | count                                      | なし                        |
--   | damage          | kind, severity（lost ⇔ lost 以外は不可）   | lost なら ended_at          |
--
-- イベントの種類は変えられない（新しい行は元の行と同じ type / target_type / target_id）。状態は変えない
-- （状態を戻す取り消しは扱わない）。出蕾の cumulative_leaves は出蕾時点の記録なので元の値を引き継ぐ（訂正で直さない）。

create function correct_observation(
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
  end case;

  insert into observations (id, stem_id, type, value, observed_at, observed_by, note)
  values (p_new_id, v_old.stem_id, v_old.type, p_value, p_observed_at, auth.uid(), coalesce(p_note, v_old.note));

  update observations set superseded_by = p_new_id where id = p_old_id;

  return p_new_id;
end;
$$;

revoke all on function correct_observation(uuid, uuid, numeric, timestamptz, text) from public;
grant execute on function correct_observation(uuid, uuid, numeric, timestamptz, text) to authenticated;

-- payload の数値の検査（整数・下限）
create function correction_int(p_payload jsonb, p_key text, p_label text, p_min integer) returns integer
language plpgsql immutable set search_path = public as $$
declare
  v jsonb := p_payload->p_key;
begin
  if v is null or jsonb_typeof(v) <> 'number' or (v::text)::numeric <> trunc((v::text)::numeric)
     or (v::text)::numeric < p_min then
    raise exception '%は % 以上の整数で入力してください', p_label, p_min;
  end if;
  return (v::text)::integer;
end $$;

create function correction_positive(p_payload jsonb, p_key text, p_label text) returns numeric
language plpgsql immutable set search_path = public as $$
declare
  v jsonb := p_payload->p_key;
begin
  if v is null or jsonb_typeof(v) <> 'number' or (v::text)::numeric <= 0 then
    raise exception '%は 0 より大きい数で入力してください', p_label;
  end if;
  return (v::text)::numeric;
end $$;

create function correct_stem_event(
  p_new_id uuid,
  p_old_id uuid,
  p_occurred_at timestamptz,
  p_payload jsonb,
  p_note text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_old events%rowtype;
  v_in jsonb := coalesce(p_payload, '{}'::jsonb);
  v_payload jsonb;
  v_date date := (p_occurred_at at time zone 'Asia/Tokyo')::date;
  v_earliest text;
  v_old_lost boolean;
  v_new_lost boolean;
begin
  if p_new_id is null or p_old_id is null or p_occurred_at is null then
    raise exception '訂正するイベントと日付を指定してください';
  end if;

  -- 冪等: 同じ id の行が既にあれば（再送）何もしない
  if exists (select 1 from events where id = p_new_id) then
    return p_new_id;
  end if;

  select * into v_old from events where id = p_old_id for update;
  if not found then
    raise exception '訂正するイベントが見つかりません';
  end if;
  if v_old.target_type <> 'stem' then
    raise exception '茎のイベントだけを訂正できます';
  end if;
  if v_old.superseded_by is not null then
    raise exception 'この記録はすでに訂正されています。最新の記録を訂正してください';
  end if;
  if p_occurred_at > now() + interval '1 day' then
    raise exception '未来の日付には訂正できません';
  end if;

  -- 茎の日付列を更新するまでロックする（RLS 外の茎は見えない）
  perform 1 from stems where id = v_old.target_id for update;
  if not found then
    raise exception '茎が見つかりません';
  end if;

  -- 新しい payload: 元の payload に、訂正できる項目だけを入れ直す（それ以外の項目は元のまま）
  case v_old.type
    when 'bud_emerged' then
      v_earliest := nullif(v_in->>'earliest_at', '');
      if v_earliest is not null then
        if v_earliest !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception '前回訪問日を YYYY-MM-DD で入力してください（空でもよい）';
        end if;
        if v_earliest::date > v_date then
          raise exception '前回訪問日は確認日より前の日付にしてください';
        end if;
      end if;
      v_payload := v_old.payload || jsonb_build_object(
        'leaves_current', correction_int(v_in, 'leaves_current', '生葉数', 0),
        'girth_cm', correction_positive(v_in, 'girth_cm', '偽茎周囲長'),
        'earliest_at', to_jsonb(v_earliest)
      );
      -- 出蕾時点の累計葉数は記録として元の値を引き継ぐ
      if v_old.payload ? 'cumulative_leaves' then
        v_payload := jsonb_set(v_payload, '{cumulative_leaves}', v_old.payload->'cumulative_leaves');
      end if;
    when 'hands_counted' then
      v_payload := v_old.payload || jsonb_build_object('hands', correction_int(v_in, 'hands', '段数', 1));
    when 'bagged', 'debudded' then
      v_payload := v_old.payload;
    when 'harvested' then
      v_payload := v_old.payload || jsonb_build_object('weight_kg', correction_positive(v_in, 'weight_kg', '果房重量'));
    when 'leaves_removed' then
      v_payload := v_old.payload || jsonb_build_object('count', correction_int(v_in, 'count', '除去した枚数', 1));
    when 'damage' then
      if coalesce(v_in->>'kind', '') not in ('lodging', 'leaf_tear', 'break', 'cold', 'disease') then
        raise exception '被害の種類を選んでください';
      end if;
      if coalesce(v_in->>'severity', '') not in ('light', 'moderate', 'severe', 'lost') then
        raise exception '被害の程度を選んでください';
      end if;
      v_old_lost := v_old.payload->>'severity' = 'lost';
      v_new_lost := v_in->>'severity' = 'lost';
      if v_old_lost and not v_new_lost then
        raise exception '「喪失」の被害は程度を変えられません（日付と種類だけ訂正できます）';
      end if;
      if v_new_lost and not v_old_lost then
        raise exception '訂正で「喪失」にはできません（茎の状態は変えられません）';
      end if;
      v_payload := v_old.payload || jsonb_build_object('kind', v_in->>'kind', 'severity', v_in->>'severity');
    else
      raise exception 'この種類のイベントは訂正できません';
  end case;

  -- 1. 新しい行を追加（種類・対象は元の行と同じ）
  insert into events (id, type, target_type, target_id, occurred_at, recorded_by, payload, note)
  values (p_new_id, v_old.type, v_old.target_type, v_old.target_id, p_occurred_at, auth.uid(), v_payload,
          coalesce(p_note, v_old.note));

  -- 2. 元の行を訂正済みにする
  update events set superseded_by = p_new_id where id = p_old_id;

  -- 3. 茎の日付列を新しい日付に（状態は変えない）
  case v_old.type
    when 'bud_emerged' then
      update stems set bud_emerged_at = v_date where id = v_old.target_id;
    when 'bagged' then
      update stems set bagged_at = v_date where id = v_old.target_id;
    when 'harvested' then
      update stems set harvested_at = v_date, ended_at = v_date where id = v_old.target_id;
    when 'damage' then
      if v_new_lost then
        update stems set ended_at = v_date where id = v_old.target_id;
      end if;
    else
      null;
  end case;

  return p_new_id;
end;
$$;

revoke all on function correct_stem_event(uuid, uuid, timestamptz, jsonb, text) from public;
grant execute on function correct_stem_event(uuid, uuid, timestamptz, jsonb, text) to authenticated;
revoke all on function correction_int(jsonb, text, text, integer) from public;
revoke all on function correction_positive(jsonb, text, text) from public;
grant execute on function correction_int(jsonb, text, text, integer) to authenticated;
grant execute on function correction_positive(jsonb, text, text) to authenticated;
