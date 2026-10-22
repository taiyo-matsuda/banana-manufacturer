-- 圃場記号（code）を追加する。株コード `圃場記号-連番`（1-3）に使う。
-- 既存行（E2E で作られた行など）があっても適用できるよう、いったん nullable で追加して
-- 組織ごとの連番で埋めてから not null にする。

alter table fields add column code text;

update fields f
set code = 'X' || lpad(n.rn::text, 3, '0')
from (
  select id, row_number() over (partition by organization_id order by created_at, id) as rn
  from fields
) n
where f.id = n.id;

alter table fields alter column code set not null;
alter table fields add constraint fields_organization_id_code_key unique (organization_id, code);
