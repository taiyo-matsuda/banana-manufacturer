import { Badge } from "@/components/ui/badge";

// 累計葉数の検算ずれ（3-5a、src/lib/leaves.ts の leafCheck）。株の詳細の茎一覧で使う（茎の画面は警告の Alert）
export function LeafCheckBadge(props: React.ComponentProps<"span">) {
  return (
    <Badge variant="outline" className="border-warning-foreground/40 bg-warning text-warning-foreground" {...props}>
      検算ずれ
    </Badge>
  );
}
