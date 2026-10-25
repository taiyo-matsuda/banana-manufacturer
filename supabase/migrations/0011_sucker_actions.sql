-- 2-2 吸芽の採用・芽かき・株分け: 吸芽の茎（status=sucker）の行き先を決める 3 つの RPC。
-- data-model.md 3 章（stems の状態遷移）・4 章（sucker_adopted / sucker_removed / sucker_transplanted）。
--
--   sucker ─┬─ sucker_adopted ──────▶ active（adopted_at, initial_leaf_count）
--           ├─ sucker_removed ──────▶ removed（ended_at）
--           └─ sucker_transplanted ─▶ transplanted（ended_at。転出先に新しい株と generation 1 の茎を作る）
--
-- 状態の前提（3 つとも吸芽の茎にだけできる）は src/lib/stemEvents.ts の SUCKER_ACTION_NEXT_STATUS /
-- canDoSuckerAction と同じ表。片方を変えたら両方を変える。DB が正本で、あちらは UI の出し分けに使う。
--
-- 共通:
-- - security invoker（RLS がそのまま効く。他組織の茎・圃場は見えないので「見つかりません」になる）
-- - 冪等: 端末（または画面）が events.id（p_event_id）を採番する。同じ id の events 行が既にあれば（同期の再送）
--   何もせず p_event_id を返す（0009 / 0010 と同じ考え方）
-- - 1 トランザクション（茎の更新・株と茎の作成・イベントの追記のどれかが失敗すれば全部入らない）
-- - organization_id は渡さない（mats は fields から、stems は mats から、events は target からトリガーがコピーする）
-- - 日付は p_occurred_at の日本時間の日付

-- 吸芽の茎を読み、ロックし、status=sucker であることを確かめる（3 つの RPC で共通）
create function lock_sucker_stem(p_stem_id uuid, p_action text) returns stems
language plpgsql security invoker set search_path = public as $$
declare
  v_stem stems%rowtype;
begin
  select * into v_stem from stems where id = p_stem_id for update;
  if not found then
    raise exception '茎が見つかりません';
  end if;
  if v_stem.status <> 'sucker' then
    raise exception '%は吸芽の茎にだけできます（この茎は%）', p_action, stem_status_label(v_stem.status);
  end if;
  return v_stem;
end;
$$;

revoke all on function lock_sucker_stem(uuid, text) from public;
grant execute on function lock_sucker_stem(uuid, text) to authenticated;

-- 採用: status=active、adopted_at、initial_leaf_count。sucker_adopted イベント（payload {initial_leaf_count}）。
-- 栽培中は最大 3 本（0001 のトリガー stems_max_active が正本）。違反はトリガーの英語の例外を日本語にして返す
create function adopt_sucker(
  p_event_id uuid,
  p_stem_id uuid,
  p_occurred_at timestamptz,
  p_initial_leaf_count integer
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_stem stems%rowtype;
  v_date date := (p_occurred_at at time zone 'Asia/Tokyo')::date;
begin
  if p_event_id is null or p_stem_id is null or p_occurred_at is null then
    raise exception 'イベントの id、茎、日付を指定してください';
  end if;
  if p_initial_leaf_count is null or p_initial_leaf_count < 0 then
    raise exception '初期葉数は 0 以上の整数で入力してください';
  end if;

  if exists (select 1 from events where id = p_event_id) then
    return p_event_id;
  end if;

  v_stem := lock_sucker_stem(p_stem_id, '採用');
  -- 同じ株の採用が同時に走っても 3 本の判定がずれないよう、株をロックする
  perform 1 from mats where id = v_stem.mat_id for update;

  begin
    update stems
      set status = 'active', adopted_at = v_date, initial_leaf_count = p_initial_leaf_count
      where id = p_stem_id;
  exception when raise_exception then
    if sqlerrm like '%already has 3 active stems%' then
      raise exception 'この株には栽培中の茎が 3 本あるため採用できません。先に他の吸芽を芽かきするか株分けしてください';
    end if;
    raise;
  end;

  insert into events (id, type, target_type, target_id, occurred_at, recorded_by, payload)
  values (p_event_id, 'sucker_adopted', 'stem', p_stem_id, p_occurred_at, auth.uid(),
          jsonb_build_object('initial_leaf_count', p_initial_leaf_count));

  return p_event_id;
end;
$$;

revoke all on function adopt_sucker(uuid, uuid, timestamptz, integer) from public;
grant execute on function adopt_sucker(uuid, uuid, timestamptz, integer) to authenticated;

-- 芽かき: status=removed、ended_at。sucker_removed イベント（payload {}）
create function remove_sucker(
  p_event_id uuid,
  p_stem_id uuid,
  p_occurred_at timestamptz,
  p_note text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_stem stems%rowtype;
  v_date date := (p_occurred_at at time zone 'Asia/Tokyo')::date;
begin
  if p_event_id is null or p_stem_id is null or p_occurred_at is null then
    raise exception 'イベントの id、茎、日付を指定してください';
  end if;

  if exists (select 1 from events where id = p_event_id) then
    return p_event_id;
  end if;

  v_stem := lock_sucker_stem(p_stem_id, '芽かき');

  update stems set status = 'removed', ended_at = v_date where id = v_stem.id;

  insert into events (id, type, target_type, target_id, occurred_at, recorded_by, payload, note)
  values (p_event_id, 'sucker_removed', 'stem', v_stem.id, p_occurred_at, auth.uid(), '{}'::jsonb, p_note);

  return p_event_id;
end;
$$;

revoke all on function remove_sucker(uuid, uuid, timestamptz, text) from public;
grant execute on function remove_sucker(uuid, uuid, timestamptz, text) to authenticated;

-- 株分け: 転出先に新しい株（id=p_new_mat_id、code=p_code、品種は元の株と同じ、origin_type=sucker_transplant、
-- origin_stem_id=吸芽、planted_at=日付）と、その generation 1 の茎（id=p_new_stem_id、status=active、
-- started_at は吸芽の started_at を引き継ぐ、adopted_at=日付、initial_leaf_count）を作り、
-- 吸芽を status=transplanted、ended_at にする。sucker_transplanted イベント（payload {to_mat_id}）。
-- - 転出先の圃場は自組織であること（RLS で他組織の圃場は見えない → 「転出先の圃場が見つかりません」）
-- - 株コードは呼び出し側が採番して渡す（1-3 / 1-4 と同じ: 圃場記号 + 既存の最大番号の次）。
--   衝突（mats の unique (field_id, code)）は SQLSTATE 23505・hint 'mat_code_conflict' の日本語の例外にする
--   （画面は採番し直して再試行する）
create function transplant_sucker(
  p_event_id uuid,
  p_stem_id uuid,
  p_occurred_at timestamptz,
  p_to_field_id uuid,
  p_lat double precision,
  p_lng double precision,
  p_code text,
  p_initial_leaf_count integer,
  p_new_mat_id uuid,
  p_new_stem_id uuid
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_stem stems%rowtype;
  v_mat mats%rowtype;
  v_date date := (p_occurred_at at time zone 'Asia/Tokyo')::date;
  v_constraint text;
begin
  if p_event_id is null or p_stem_id is null or p_occurred_at is null or p_to_field_id is null
     or p_new_mat_id is null or p_new_stem_id is null then
    raise exception 'イベントの id、茎、日付、転出先の圃場、新しい株と茎の id を指定してください';
  end if;
  if p_lat is null or p_lng is null then
    raise exception '転出先の位置を地図で指定してください';
  end if;
  if p_code is null or btrim(p_code) = '' then
    raise exception '新しい株のコードを指定してください';
  end if;
  if p_initial_leaf_count is null or p_initial_leaf_count < 0 then
    raise exception '初期葉数は 0 以上の整数で入力してください';
  end if;

  if exists (select 1 from events where id = p_event_id) then
    return p_event_id;
  end if;

  v_stem := lock_sucker_stem(p_stem_id, '株分け');

  if not exists (select 1 from fields where id = p_to_field_id) then
    raise exception '転出先の圃場が見つかりません';
  end if;

  select * into v_mat from mats where id = v_stem.mat_id;

  -- 1. 新しい株（organization_id はトリガーが fields からコピーする）
  begin
    insert into mats (id, field_id, code, cultivar_id, lat, lng, planted_at, origin_type, origin_stem_id)
    values (p_new_mat_id, p_to_field_id, btrim(p_code), v_mat.cultivar_id, p_lat, p_lng, v_date,
            'sucker_transplant', v_stem.id);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'mats_field_id_code_key' then
      raise exception '株コード % は既に使われています', btrim(p_code)
        using errcode = '23505', hint = 'mat_code_conflict';
    end if;
    raise;
  end;

  -- 2. その generation 1 の茎（栽培中。started_at は吸芽の発生日を引き継ぐ）
  insert into stems (id, mat_id, generation, parent_stem_id, status, started_at, adopted_at, initial_leaf_count)
  values (p_new_stem_id, p_new_mat_id, 1, null, 'active', v_stem.started_at, v_date, p_initial_leaf_count);

  -- 3. 元の吸芽は株分け済み
  update stems set status = 'transplanted', ended_at = v_date where id = v_stem.id;

  -- 4. 吸芽にイベントを追記
  insert into events (id, type, target_type, target_id, occurred_at, recorded_by, payload)
  values (p_event_id, 'sucker_transplanted', 'stem', v_stem.id, p_occurred_at, auth.uid(),
          jsonb_build_object('to_mat_id', p_new_mat_id));

  return p_event_id;
end;
$$;

revoke all on function transplant_sucker(uuid, uuid, timestamptz, uuid, double precision, double precision, text, integer, uuid, uuid) from public;
grant execute on function transplant_sucker(uuid, uuid, timestamptz, uuid, double precision, double precision, text, integer, uuid, uuid) to authenticated;
