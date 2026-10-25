-- 2-3 株の位置の修正: 地図の「位置を直す」モードで動かした株の mats.lat / lng を 1 回でまとめて更新する。
-- 位置は株の属性の修正なので events は作らない（観測・イベントではない。1-9 の設計どおりオンラインのみ）。
--
-- p_moves: [{"mat_id": uuid, "lat": number, "lng": number}, ...]（src/lib/mats/relocate.ts の validateRelocateInput で検証済み）
-- - 対象はその圃場（p_field_id）の撤去していない株だけ。1 つでも見つからなければ（他組織・撤去済み・別の圃場）
--   日本語の例外にして、どれも更新しない（1 トランザクション）
-- - security invoker（RLS の mats_all がそのまま効く）
-- - 戻り値は更新した株の数
create function relocate_mats(p_field_id uuid, p_moves jsonb) returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_move jsonb;
  v_lat double precision;
  v_lng double precision;
  v_count integer := 0;
begin
  if p_field_id is null or p_moves is null or jsonb_typeof(p_moves) <> 'array' or jsonb_array_length(p_moves) = 0 then
    raise exception '動かした株がありません';
  end if;

  for v_move in select * from jsonb_array_elements(p_moves) loop
    v_lat := (v_move ->> 'lat')::double precision;
    v_lng := (v_move ->> 'lng')::double precision;
    if v_lat is null or v_lng is null or abs(v_lat) > 90 or abs(v_lng) > 180 then
      raise exception '位置が正しくありません';
    end if;
    update mats set lat = v_lat, lng = v_lng
      where id = (v_move ->> 'mat_id')::uuid and field_id = p_field_id and status = 'active';
    if not found then
      raise exception '位置を直す株が見つかりません（撤去されたか、別の圃場の株です）。画面を再読み込みしてやり直してください';
    end if;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function relocate_mats(uuid, jsonb) from public;
grant execute on function relocate_mats(uuid, jsonb) to authenticated;
