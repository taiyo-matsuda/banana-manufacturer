-- fields は organizations 直下のテーブルで、親からコピーするトリガーがない。
-- アプリは organization_id を渡さない方針（data-model.md 2.1）なので、
-- ログイン中ユーザーの組織（current_org()）を既定値にする。
-- 未ログイン（current_org() が null）の insert は not null 制約と RLS で拒否される。

alter table fields alter column organization_id set default current_org();
