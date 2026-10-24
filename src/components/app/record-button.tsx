import { cn } from "cn";
import { Button } from "@/components/ui/button";

// 現場用の大きな記録ボタン（UX-1）。高さ 64px 以上・幅いっぱい。葉数の +1 / +2 などの主役に使う。
// タップ＝記録（保存ボタンはない）。
export function RecordButton({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      size="lg"
      data-slot="record-button"
      className={cn("h-16 w-full text-2xl font-semibold", className)}
      {...props}
    />
  );
}
