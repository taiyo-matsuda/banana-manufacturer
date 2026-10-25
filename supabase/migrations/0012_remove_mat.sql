-- 2-3 株の撤去（要確認 11 の決定: 撤去した株は地図・株の一覧に出さず、株の詳細は「撤去済み」として開ける。
-- 栽培中の茎がある株は撤去できない）。data-model.md 2 章（mats.status）・4 章（mat_removed、payload {reason}）。
--
-- remove_mat: mats.status=removed と mat_removed イベント（target_type=mat）を 1 トランザクションで書く。
-- - その株に status in ('active','flowered','sucker') の茎があれば日本語の例外（栽培中の茎、または未処理の吸芽。
--   吸芽は先に芽かき・株分け・採用を決めてもらう）。判定の表は src/lib/mats/remove.ts の canRemoveMat と同じ。
--   片方を変えたら両方を変える。DB が正本で、あちらは画面の事前判定に使う
-- - security invoker（RLS がそのまま効く。他組織の株は見えないので「見つかりません」）
-- - 冪等: 呼び出し側が events.id（p_event_id）を採番する。同じ id の events 行が既にあれば何もせず p_event_id を返す
--   （0009〜0011 と同じ考え方）
-- - organization_id は渡さない（events はトリガーが target の株からコピーする）
-- - 撤去した株のコードは欠番のまま（採番は撤去した株も含めた最大番号の次。src/lib/mats/code.ts）。行は消さない
create function remove_mat(
  p_event_id uuid,
  p_mat_id uuid,
  p_occurred_at timestamptz,
  p_reason text
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_mat mats%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_event_id is null or p_mat_id is null or p_occurred_at is null then
    raise exception 'イベントの id、株、日付を指定してください';
  end if;
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception '理由は 500 文字以内で入力してください';
  end if;

  if exists (select 1 from events where id = p_event_id) then
    return p_event_id;
  end if;

  -- 同じ株への茎の追加・吸芽の記録と同時に走っても判定がずれないよう、株をロックする
  select * into v_mat from mats where id = p_mat_id for update;
  if not found then
    raise exception '株が見つかりません';
  end if;
  if v_mat.status = 'removed' then
    raise exception 'この株は既に撤去済みです';
  end if;

  if exists (select 1 from stems where mat_id = p_mat_id and status in ('active', 'flowered')) then
    raise exception '栽培中の茎があるため撤去できません。先に収穫・喪失などで茎を終えてください';
  end if;
  if exists (select 1 from stems where mat_id = p_mat_id and status = 'sucker') then
    raise exception '未処理の吸芽があるため撤去できません。先に吸芽の芽かき・株分け・採用を決めてください';
  end if;

  update mats set status = 'removed' where id = p_mat_id;

  insert into events (id, type, target_type, target_id, occurred_at, recorded_by, payload)
  values (p_event_id, 'mat_removed', 'mat', p_mat_id, p_occurred_at, auth.uid(),
          jsonb_build_object('reason', v_reason));

  return p_event_id;
end;
$$;

revoke all on function remove_mat(uuid, uuid, timestamptz, text) from public;
grant execute on function remove_mat(uuid, uuid, timestamptz, text) to authenticated;
