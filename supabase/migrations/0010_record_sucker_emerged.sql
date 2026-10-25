-- 2-1 吸芽の発生の記録: 吸芽の茎（stems、status=sucker）の作成と、親茎への sucker_emerged イベントの追記を
-- 同一トランザクションで行う RPC。data-model.md 3 章（stems の状態遷移）・4 章（sucker_emerged）。
--
-- - security invoker（RLS がそのまま効く。他組織の茎は見えないので「親茎が見つかりません」になる）
-- - 冪等: 端末が events.id（p_event_id）と吸芽の茎の id（p_sucker_stem_id）を採番する。同じ p_event_id の events 行が
--   既にあれば（同期の再送）何もせず p_event_id を返す（0009 と同じ考え方）
-- - 親茎は栽培中（active / flowered）であること
-- - 吸芽の茎: mat_id=親の mat_id、generation=親+1、parent_stem_id=親、status=sucker、
--   started_at=p_occurred_at の日本時間の日付、initial_leaf_count=0（採用時に入れる。2-2）
-- - organization_id は渡さない（stems は mats から、events は target からトリガーがコピーする）
-- - 吸芽（sucker）は最大 3 本の制約（0001 の stems_max_active）に数えない（トリガーは active / flowered だけを数える）
-- - payload は端末が組み立てたもの（parent_cumulative_leaves など）に sucker_stem_id を必ず入れる
create function record_sucker_emerged(
  p_event_id uuid,
  p_sucker_stem_id uuid,
  p_parent_stem_id uuid,
  p_occurred_at timestamptz,
  p_payload jsonb,
  p_note text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_parent stems%rowtype;
  v_date date := (p_occurred_at at time zone 'Asia/Tokyo')::date;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('sucker_stem_id', p_sucker_stem_id);
begin
  if p_event_id is null or p_sucker_stem_id is null or p_parent_stem_id is null or p_occurred_at is null then
    raise exception 'イベントの id、吸芽の茎の id、親茎、日付を指定してください';
  end if;

  -- 冪等: 同じ id の行が既にあれば（同期の再送）何もしない。RLS で自組織の行だけ見える
  if exists (select 1 from events where id = p_event_id) then
    return p_event_id;
  end if;

  -- 親茎（RLS 外の茎は見えない）。記録が終わるまでロックする
  select * into v_parent from stems where id = p_parent_stem_id for update;
  if not found then
    raise exception '親茎が見つかりません';
  end if;
  if v_parent.status not in ('active', 'flowered') then
    raise exception '吸芽は栽培中または出蕾済みの茎にだけ記録できます（この茎は%）', stem_status_label(v_parent.status);
  end if;

  -- 1. 吸芽の茎を作る（organization_id はトリガーが mats からコピーする）
  insert into stems (id, mat_id, generation, parent_stem_id, status, started_at, initial_leaf_count)
  values (p_sucker_stem_id, v_parent.mat_id, v_parent.generation + 1, v_parent.id, 'sucker', v_date, 0);

  -- 2. 親茎にイベントを追記（同一トランザクション。失敗すれば吸芽の茎も入らない）
  insert into events (id, type, target_type, target_id, occurred_at, recorded_by, payload, note)
  values (p_event_id, 'sucker_emerged', 'stem', v_parent.id, p_occurred_at, auth.uid(), v_payload, p_note);

  return p_event_id;
end;
$$;

revoke all on function record_sucker_emerged(uuid, uuid, uuid, timestamptz, jsonb, text) from public;
grant execute on function record_sucker_emerged(uuid, uuid, uuid, timestamptz, jsonb, text) to authenticated;
