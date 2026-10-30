"use client";

import { FieldFilter } from "./field-filter";

// 今週見る株の全件（/weekly）の圃場の絞り込み（2-7）。選ぶと /weekly?field=<id>（「すべての圃場」は /weekly）へ遷移する
export function WeeklyFieldFilter({
  fields,
  current,
}: {
  fields: { id: string; name: string }[];
  current: string | undefined;
}) {
  return <FieldFilter fields={fields} current={current} basePath="/weekly" prefix="weekly" />;
}
