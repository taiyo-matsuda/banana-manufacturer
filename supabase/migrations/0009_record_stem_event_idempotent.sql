-- 1-9 オフライン同期: record_stem_event を冪等にする。
-- 端末が events.id を採番して p_id で渡し、その id の行が既にあれば（再送）何もせず p_id を返す。
-- 0008 の関数はシグネチャが変わるので drop → create（0008 自体は編集しない）。本体の表と検査は 0008 と同じ:
--
--   | type                                          | 記録できる状態      | 記録後の状態                      |
--   |-----------------------------------------------|---------------------|-----------------------------------|
--   | bud_emerged                                   | active              | flowered（bud_emerged_at）        |
--   | hands_counted / bagged / debudded             | flowered            | 変わらない（bagged は bagged_at） |
--   | harvested                                     | flowered            | harvested（harvested_at, ended_at）|
--   | damage                                        | active / flowered   | severity=lost なら lost（ended_at）。それ以外は変わらない |
--   | 上記以外（leaves_removed, fertilized, sucker_emerged など） | この関数では受け付けない（例外） |
--
-- src/lib/stemEvents.ts の ALLOWED_STATUSES と同じ表。片方を変えたら両方を変える。
drop function record_stem_event(uuid, event_type, timestamptz, jsonb, text);

create function record_stem_event(
  p_id uuid,
  p_stem_id uuid,
  p_type event_type,
  p_occurred_at timestamptz,
  p_payload jsonb,
  p_note text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_status stem_status;
  v_date date := (p_occurred_at at time zone 'Asia/Tokyo')::date;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_label text;
  v_severity text;
begin
  if p_id is null or p_stem_id is null or p_occurred_at is null then
    raise exception 'イベントの id、茎、日付を指定してください';
  end if;

  -- 冪等: 同じ id の行が既にあれば（同期の再送）何もしない。RLS で自組織の行だけ見える
  if exists (select 1 from events where id = p_id) then
    return p_id;
  end if;

  -- 茎の現在の状態（RLS 外の茎は見えない）。更新までロックする
  select status into v_status from stems where id = p_stem_id for update;
  if not found then
    raise exception '茎が見つかりません';
  end if;

  v_label := case p_type
    when 'bud_emerged' then '出蕾'
    when 'hands_counted' then '段数'
    when 'bagged' then '袋掛け'
    when 'debudded' then '摘蕾'
    when 'harvested' then '収穫'
    when 'damage' then '被害'
    else p_type::text
  end;

  -- 状態の前提（src/lib/stemEvents.ts の ALLOWED_STATUSES と同じ表）
  case p_type
    when 'bud_emerged' then
      if v_status <> 'active' then
        raise exception '出蕾は栽培中の茎にだけ記録できます（この茎は%）', stem_status_label(v_status);
      end if;
    when 'hands_counted', 'bagged', 'debudded', 'harvested' then
      if v_status <> 'flowered' then
        raise exception '%は出蕾済みの茎にだけ記録できます（この茎は%）', v_label, stem_status_label(v_status);
      end if;
    when 'damage' then
      if v_status not in ('active', 'flowered') then
        raise exception '被害は栽培中または出蕾済みの茎にだけ記録できます（この茎は%）', stem_status_label(v_status);
      end if;
      v_severity := v_payload->>'severity';
      if v_severity is null or v_severity not in ('light', 'moderate', 'severe', 'lost') then
        raise exception '被害の程度を指定してください';
      end if;
    else
      raise exception '% はこの関数では記録できません', v_label;
  end case;

  -- 1. イベントを追記（id は端末が採番したもの。organization_id はトリガーが入れる）
  insert into events (id, type, target_type, target_id, occurred_at, recorded_by, payload, note)
  values (p_id, p_type, 'stem', p_stem_id, p_occurred_at, auth.uid(), v_payload, p_note);

  -- 2. 茎の状態・日付列を更新（同一トランザクション。失敗すればイベントも入らない）
  case p_type
    when 'bud_emerged' then
      update stems set status = 'flowered', bud_emerged_at = v_date where id = p_stem_id;
    when 'bagged' then
      update stems set bagged_at = v_date where id = p_stem_id;
    when 'harvested' then
      update stems set status = 'harvested', harvested_at = v_date, ended_at = v_date where id = p_stem_id;
    when 'damage' then
      if v_severity = 'lost' then
        update stems set status = 'lost', ended_at = v_date where id = p_stem_id;
      end if;
    else
      -- hands_counted / debudded は stems を更新しない
      null;
  end case;

  return p_id;
end;
$$;

revoke all on function record_stem_event(uuid, uuid, event_type, timestamptz, jsonb, text) from public;
grant execute on function record_stem_event(uuid, uuid, event_type, timestamptz, jsonb, text) to authenticated;
