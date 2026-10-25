-- 2-7 今週見る株（画面 1、要件 4.2・UC-2・要確認 16）。
-- ホームの「今週見る株」が 1 回の問い合わせで引けるよう、撤去していない株の栽培中・出蕾済みの茎ごとに
-- 株・圃場の表示項目と「葉の観測の要約」（最後の leaves_new の日時と leaves_new の合計）を返す view。
-- 観測は全件を返さない（茎ごとに 1 行）。並べ替え・閾値・今日の除外・未同期分の重ね合わせは src/lib/weekly.ts（純粋関数）。
--
-- - security_invoker = true: 呼び出したユーザーの RLS がそのまま効く（他組織の株・茎・観測は見えない）
-- - 現在の値だけ（superseded_by is null）。訂正で追加された行は superseded_by が null なので含まれる
-- - 累計葉数 = initial_leaf_count + leaves_new_sum（leaves.ts の cumulativeLeaves と同じ）
-- - 観測の要約は茎ごとの lateral（observations_stem_idx (stem_id, observed_at) を使う）
create view weekly_stems with (security_invoker = true) as
select
  s.id as stem_id,
  s.mat_id,
  m.code as mat_code,
  m.status as mat_status,
  m.field_id,
  f.name as field_name,
  s.generation,
  s.status,
  s.started_at,
  s.bud_emerged_at,
  s.initial_leaf_count,
  o.last_leaves_new_at,
  coalesce(o.leaves_new_sum, 0) as leaves_new_sum
from stems s
join mats m on m.id = s.mat_id
join fields f on f.id = m.field_id
left join lateral (
  select max(ob.observed_at) as last_leaves_new_at, sum(ob.value) as leaves_new_sum
  from observations ob
  where ob.stem_id = s.id and ob.type = 'leaves_new' and ob.superseded_by is null
) o on true
where m.status = 'active' and s.status in ('active', 'flowered');

grant select on weekly_stems to authenticated;
