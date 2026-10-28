-- 3-3 収穫予測日（prediction.md 2・7 章、data-model.md 2.3）。
--
-- 1. estimates を追記のみにする: 0001 の estimates_all（for all）を、読み取り（select）と追記（insert）だけのポリシーに置き換える。
--    推定は再計算のたびに新しい行を追記し、古い推定は残す（上書き・削除しない）。最新は computed_at desc の先頭。
--    service_role（日次の Cron）と security definer の E2E の掃除（0006、テスト農園だけ）は RLS を通らないので影響しない
-- 2. 日付の推定の順序の検査（lower_date ≤ value_date ≤ upper_date。null は検査しない）
-- 3. latest_estimates（ビュー）: 茎 × kind ごとの最新の推定 1 行。株の詳細の茎一覧・茎の画面（・3-6 の予測一覧）が
--    推定の履歴を全部読まずに済むように。security_invoker なので estimates の RLS（自組織だけ）がそのまま効く
--
-- 既存の 0001〜0020 は編集しない。

drop policy estimates_all on estimates;
create policy estimates_read on estimates for select using (organization_id = current_org());
create policy estimates_insert on estimates for insert with check (organization_id = current_org());

alter table estimates
  add constraint estimates_date_order check (
    (lower_date is null or value_date is null or lower_date <= value_date)
    and (upper_date is null or value_date is null or value_date <= upper_date)
  );

create view latest_estimates with (security_invoker = true) as
select distinct on (stem_id, kind)
  id,
  organization_id,
  stem_id,
  kind,
  value,
  lower,
  upper,
  value_date,
  lower_date,
  upper_date,
  model_version,
  inputs,
  computed_at
from estimates
order by stem_id, kind, computed_at desc, id desc;

revoke all on latest_estimates from anon;
grant select on latest_estimates to authenticated, service_role;
