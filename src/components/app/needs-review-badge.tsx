import { Badge } from "@/components/ui/badge";

// 収穫予測の「要確認」（3-3、prediction.md 7 章: 茎・株・圃場の severe の被害）。茎の画面と株の詳細の茎一覧で使う
export function NeedsReviewBadge(props: React.ComponentProps<"span">) {
  return (
    <Badge variant="outline" className="border-warning-foreground/40 bg-warning text-warning-foreground" {...props}>
      要確認
    </Badge>
  );
}
