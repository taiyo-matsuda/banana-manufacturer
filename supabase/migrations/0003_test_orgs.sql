-- E2E テスト用の組織とユーザー
-- テスト農園 A: ほぼ全ての E2E がこれでログインする
-- テスト農園 B: 組織の分離（RLS）を検証するためだけに使う。A のデータが見えないことを確認する
-- 本番の組織（松田農園）とは RLS で分離されるため、同じプロジェクトに置いて問題ない。

insert into organizations (id, name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'テスト農園A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'テスト農園B')
on conflict (id) do nothing;

insert into profiles (id, organization_id, display_name, role) values
  ('8991364a-228c-4fa4-84ee-b899d857d452', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'テストA', 'owner'),
  ('b359ea72-68c0-43ff-89d8-f5509e0eac0c', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'テストB', 'owner')
on conflict (id) do nothing;
