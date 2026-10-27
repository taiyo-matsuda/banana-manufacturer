-- 初期データ: 最初の組織と、ダッシュボードで作成したオーナーの profiles 行
-- このファイルは環境固有（本番の最初のユーザー）。再実行しても二重にならないようにしてある。
--
-- 【既存マイグレーションの編集の例外（タスク 0-3）】
-- profiles.id は auth.users への FK なので、そのユーザーがいない環境（手元の Supabase。`npx supabase start` /
-- `db reset`）では profiles の insert が FK 違反で失敗し、以降のマイグレーションが適用できなかった。
-- そのため 0002・0003 に限り、auth.users にユーザーがいるときだけ profiles を入れる形に編集した
-- （`insert ... select ... where exists (select 1 from auth.users ...)`）。ユーザーが無い環境では何もしない。
-- リモート（本番）では適用済みで再実行されないので影響しない。ほかの既存マイグレーションは編集しない。
-- 理由と方針は docs/02_design/data-model.md「マイグレーションの扱い」と architecture.md 7 章。

insert into organizations (id, name)
values ('11111111-1111-4111-8111-111111111111', '松田農園')
on conflict (id) do nothing;

insert into profiles (id, organization_id, display_name, role)
select '493b3719-1ae2-4d3c-b304-11072513f53d', '11111111-1111-4111-8111-111111111111', '松田', 'owner'
where exists (select 1 from auth.users where id = '493b3719-1ae2-4d3c-b304-11072513f53d')
on conflict (id) do nothing;
