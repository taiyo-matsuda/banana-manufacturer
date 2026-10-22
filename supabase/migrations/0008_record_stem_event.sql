-- 茎のイベント記録（1-8）: events への追記と stems の状態・日付列の更新を同一トランザクションで行う RPC。
-- data-model.md 3 章「イベントから stems.status と日付列を更新するのはアプリ側の責務（同一トランザクション内で行う RPC を用意する）」。
--
-- - security invoker（RLS がそのまま効く。他組織の茎は見えないので「茎が見つかりません」になる）
-- - organization_id は渡さない（events の INSERT トリガー events_set_org が target からコピーする）
-- - 状態の前提（どの状態でどのイベントを記録できるか）は src/lib/stemEvents.ts と同じ表。片方を変えたら両方を変える:
--
--   | type                                          | 記録できる状態      | 記録後の状態                      |
--   |-----------------------------------------------|---------------------|-----------------------------------|
--   | bud_emerged                                   | active              | flowered（bud_emerged_at）        |
--   | hands_counted / bagged / debudded             | flowered            | 変わらない（bagged は bagged_at） |
--   | harvested                                     | flowered            | harvested（harvested_at, ended_at）|
--   | damage                                        | active / flowered   | severity=lost なら lost（ended_at）。それ以外は変わらない |
--   | 上記以外（leaves_removed, fertilized, sucker_emerged など） | この関数では受け付けない（例外） |
--
-- 日付列は occurred_at を日本時間（Asia/Tokyo）で日付にしたもの（沖縄の露地栽培。UTC の日付にすると前日になる）。
-- 例外メッセージ用の状態の日本語（src/lib/stems/status.ts の STEM_STATUS_LABELS と同じ）
create function stem_status_label(s stem_status) returns text
language sql immutable set search_path = public as $$
  select case s
    when 'sucker' then '吸芽'
    when 'active' then '栽培中'
    when 'flowered' then '出蕾済み'
    when 'harvested' then '収穫済み'
    when 'removed' then '芽かき'
    when 'transplanted' then '株分け'
    when 'lost' then '喪失'
  end
$$;

create function record_stem_event(
  p_stem_id uuid,
  p_type event_type,
  p_occurred_at timestamptz,
  p_payload jsonb,
  p_note text default null
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_status stem_status;
  v_event_id uuid;
  v_date date := (p_occurred_at at time zone 'Asia/Tokyo')::date;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_label text;
  v_severity text;
begin
  if p_stem_id is null or p_occurred_at is null then
    raise exception '茎と日付を指定してください';
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

  -- 1. イベントを追記（organization_id はトリガーが入れる）
  insert into events (type, target_type, target_id, occurred_at, recorded_by, payload, note)
  values (p_type, 'stem', p_stem_id, p_occurred_at, auth.uid(), v_payload, p_note)
  returning id into v_event_id;

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

  return v_event_id;
end;
$$;

revoke all on function record_stem_event(uuid, event_type, timestamptz, jsonb, text) from public;
grant execute on function record_stem_event(uuid, event_type, timestamptz, jsonb, text) to authenticated;
revoke all on function stem_status_label(stem_status) from public;
grant execute on function stem_status_label(stem_status) to authenticated;
