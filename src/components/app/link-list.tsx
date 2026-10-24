import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "cn";

// タップで遷移する行の一覧（UX-1）: 圃場の一覧、茎の一覧、最近開いた株など。
// 行は高さ 56px 以上（タップ領域）。右端に「>」。
export function LinkList({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="link-list"
      className={cn("flex flex-col divide-y overflow-hidden rounded-lg bg-card ring-1 ring-foreground/10", className)}
      {...props}
    />
  );
}

export function LinkListItem(props: React.ComponentProps<"li">) {
  return <li data-slot="link-list-item" {...props} />;
}

export function LinkRow({ className, children, ...props }: React.ComponentProps<typeof Link>) {
  return (
    <Link
      data-slot="link-row"
      className={cn("flex min-h-14 items-center justify-between gap-3 px-4 py-2 active:bg-muted", className)}
      {...props}
    >
      <span className="flex min-w-0 flex-1 items-center justify-between gap-3">{children}</span>
      <ChevronRightIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}
