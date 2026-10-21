-- 初期データ: 最初の組織と、ダッシュボードで作成したオーナーの profiles 行
-- このファイルは環境固有（本番の最初のユーザー）。再実行しても二重にならないようにしてある。

insert into organizations (id, name)
values ('11111111-1111-4111-8111-111111111111', '松田農園')
on conflict (id) do nothing;

insert into profiles (id, organization_id, display_name, role)
values ('493b3719-1ae2-4d3c-b304-11072513f53d', '11111111-1111-4111-8111-111111111111', '松田', 'owner')
on conflict (id) do nothing;
