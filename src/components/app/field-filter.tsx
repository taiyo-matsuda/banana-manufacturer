"use client";

import { useRouter } from "next/navigation";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

// 圃場で絞り込む選択式（2-7 の今週見る株、3-6 の予測一覧）。圃場が何件・どんな長さでも 1 行に収まるよう選択式にする。
// 選ぶと <basePath>?field=<id>（「すべての圃場」は <basePath>）へ遷移する。testid は <prefix>-field-filter / <prefix>-field-select
export function FieldFilter({
  fields,
  current,
  basePath,
  prefix,
}: {
  fields: { id: string; name: string }[];
  current: string | undefined;
  basePath: string;
  prefix: string;
}) {
  const router = useRouter();
  return (
    <div className="flex flex-col gap-2" data-testid={`${prefix}-field-filter`}>
      <Label htmlFor={`${prefix}-field`}>圃場で絞り込む</Label>
      <NativeSelect
        id={`${prefix}-field`}
        data-testid={`${prefix}-field-select`}
        value={current ?? ""}
        onChange={(e) => router.push(e.target.value ? `${basePath}?field=${e.target.value}` : basePath)}
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
