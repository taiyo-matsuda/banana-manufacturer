-- 写真の保存先: Supabase Storage の非公開バケット `photos`（architecture.md 4 章）。
-- パスは `{organization_id}/{target_type}/{target_id}/{photo_id}.jpg`。
-- Storage のポリシーもパスの最初のフォルダ（organization_id）で自組織に制限する。
-- 写真は追記のみなので delete は許可しない。ただし E2E の掃除（0006 と同じ考え方）のために、
-- 組織名が「テスト農園」で始まる E2E 専用組織だけは自組織のオブジェクトを消せる。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'photos',
  'photos',
  false,
  10485760, -- 10 MB（端末側で長辺 2048px に縮小してから送る）
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
on conflict (id) do nothing;

-- 自組織のフォルダ配下だけ読み書きできる
create policy photos_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = public.current_org()::text);

create policy photos_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = public.current_org()::text);

create policy photos_objects_update on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = public.current_org()::text)
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = public.current_org()::text);

-- E2E 専用組織（名前が「テスト農園」で始まる）だけ削除できる。本番の組織は削除不可のまま
create policy photos_objects_delete_e2e on storage.objects for delete to authenticated
  using (
    bucket_id = 'photos'
    and (storage.foldername(name))[1] = public.current_org()::text
    and exists (
      select 1 from public.organizations o
      where o.id = public.current_org() and o.name like 'テスト農園%'
    )
  );
