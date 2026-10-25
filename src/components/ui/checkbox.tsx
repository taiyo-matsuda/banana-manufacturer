import * as React from "react"
import { cn } from "cn"
import { CheckIcon } from "lucide-react"

// チェックボックス（見た目は 24px）。shadcn/ui の Checkbox と同じ見た目を、ネイティブの <input type="checkbox"> で作る。
// - Radix の Checkbox は SSR で隠し input の style がハイドレーションで食い違う警告を出し、
//   400 株の一覧（施肥 2-4）では行ごとに部品が重くなるため、軽いネイティブ要素にする
// - タップ領域（44px 以上）は呼び出し側の <label> で確保する
function Checkbox({
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <span className="relative inline-flex size-6 shrink-0" data-slot="checkbox-wrapper">
      <input
        type="checkbox"
        data-slot="checkbox"
        className={cn(
          "peer size-6 shrink-0 cursor-pointer appearance-none rounded-lg border border-input bg-background transition-colors outline-none checked:border-primary checked:bg-primary focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive dark:bg-input/30 dark:checked:bg-primary",
          className
        )}
        {...props}
      />
      <CheckIcon
        className="pointer-events-none absolute inset-0 m-auto size-4 text-primary-foreground opacity-0 peer-checked:opacity-100"
        aria-hidden="true"
      />
    </span>
  )
}

export { Checkbox }
