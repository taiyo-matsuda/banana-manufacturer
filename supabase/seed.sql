-- 手元の Supabase（`npx supabase start` / `npx supabase db reset`）だけで使うシード。
-- リモート（本番）には適用しない（`supabase db push` はシードを流さない）。
--
-- E2E 用のテスト農園 A / B と、そのログインユーザー（パスワード付き）を作る。
-- - 組織は 0003_test_orgs.sql がマイグレーションで作る（ここでも on conflict do nothing で入れ、重複で失敗しない）
-- - 0003 の profiles は auth.users にユーザーがいるときだけ入る形なので、手元ではここで auth ユーザー → profiles の順に作る
-- - id は 0003 と同じ UUID
-- パスワードは開発用の固定値（手元の Supabase の外では使わない）。.env.local の E2E_PASSWORD / E2E_B_PASSWORD と合わせる。
--
-- auth.users に直接入れるときの注意（GoTrue のログインが失敗しないように）:
-- - パスワードは bcrypt（extensions.crypt + gen_salt('bf')）
-- - email_confirmed_at を入れる（未確認だとログインできない）
-- - トークン系の列（confirmation_token など）は空文字。NULL だと GoTrue がスキャンに失敗してログインが 500 になる
-- - auth.identities にも email プロバイダの行を作る

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select
  '00000000-0000-0000-0000-000000000000', v.id::uuid, 'authenticated', 'authenticated', v.email,
  extensions.crypt(v.password, extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
  '', '', '', '', '', '', '', ''
from (values
  ('8991364a-228c-4fa4-84ee-b899d857d452', 'test-a@example.com', 'local-dev-password-a'),
  ('b359ea72-68c0-43ff-89d8-f5509e0eac0c', 'test-b@example.com', 'local-dev-password-b')
) as v (id, email, password)
on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select
  v.id::uuid, v.id::uuid, v.id, 'email',
  jsonb_build_object('sub', v.id, 'email', v.email, 'email_verified', true, 'phone_verified', false),
  now(), now(), now()
from (values
  ('8991364a-228c-4fa4-84ee-b899d857d452', 'test-a@example.com'),
  ('b359ea72-68c0-43ff-89d8-f5509e0eac0c', 'test-b@example.com')
) as v (id, email)
on conflict do nothing;

insert into organizations (id, name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'テスト農園A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'テスト農園B')
on conflict (id) do nothing;

insert into profiles (id, organization_id, display_name, role) values
  ('8991364a-228c-4fa4-84ee-b899d857d452', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'テストA', 'owner'),
  ('b359ea72-68c0-43ff-89d8-f5509e0eac0c', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'テストB', 'owner')
on conflict (id) do nothing;
