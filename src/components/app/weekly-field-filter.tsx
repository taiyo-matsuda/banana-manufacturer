"use client";

import { useRouter } from "next/navigation";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

// 今週見る株の全件（/weekly）の圃場の絞り込み（2-7）。圃場が何件・どんな長さでも 1 行に収まるよう選択式にする。
// 選ぶと /weekly?field=<id>（「すべての圃場」は /weekly）へ遷移する
export function WeeklyFieldFilter({
  fields,
  current,
}: {
  fields: { id: string; name: string }[];
  current: string | undefined;
}) {
  const router = useRouter();
  return (
    <div className="flex flex-col gap-2" data-testid="weekly-field-filter">
      <Label htmlFor="weekly-field">圃場で絞り込む</Label>
      <NativeSelect
        id="weekly-field"
        data-testid="weekly-field-select"
        value={current ?? ""}
        onChange={(e) => router.push(e.target.value ? `/weekly?field=${e.target.value}` : "/weekly")}
      >
        <NativeSelectOption value="">すべての圃場</NativeSelectOption>
        {fields.map((f) => (
          <NativeSelectOption key={f.id} value={f.id}>
            {f.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}
