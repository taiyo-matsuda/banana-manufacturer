-- E2E テスト用の組織とユーザー
-- テスト農園 A: ほぼ全ての E2E がこれでログインする
-- テスト農園 B: 組織の分離（RLS）を検証するためだけに使う。A のデータが見えないことを確認する
-- 本番の組織（松田農園）とは RLS で分離されるため、同じプロジェクトに置いて問題ない。
--
-- 【既存マイグレーションの編集の例外（タスク 0-3）】
-- profiles.id は auth.users への FK なので、テストユーザーがまだいない環境（手元の Supabase。
-- マイグレーションはシード `supabase/seed.sql` より先に走る）では profiles の insert が FK 違反で失敗した。
-- そのため 0002・0003 に限り、auth.users にユーザーがいるときだけ profiles を入れる形に編集した。
-- 手元では組織だけをここで作り、auth ユーザーと profiles はシード（seed.sql）が作る（シード側も on conflict do nothing）。
-- リモート（本番）では適用済みで再実行されないので影響しない。ほかの既存マイグレーションは編集しない。
-- 理由と方針は docs/02_design/data-model.md「マイグレーションの扱い」と architecture.md 7 章。

insert into organizations (id, name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'テスト農園A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'テスト農園B')
on conflict (id) do nothing;

insert into profiles (id, organization_id, display_name, role)
select v.id::uuid, v.organization_id::uuid, v.display_name, v.role
from (values
  ('8991364a-228c-4fa4-84ee-b899d857d452', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'テストA', 'owner'),
  ('b359ea72-68c0-43ff-89d8-f5509e0eac0c', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'テストB', 'owner')
) as v (id, organization_id, display_name, role)
where exists (select 1 from auth.users u where u.id = v.id::uuid)
on conflict (id) do nothing;
