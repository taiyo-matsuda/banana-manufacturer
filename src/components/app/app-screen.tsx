import { cn } from "cn";
import { BottomNav, type NavTab } from "./bottom-nav";
import { PageHeader } from "./page-header";

// 画面の枠（UX-1）: PageHeader ＋ <main> ＋ BottomNav。ログイン・オフライン以外の全画面はこれで作る。
// <main> は画面に 1 つ（E2E は `main:visible` で表示中の画面に絞る）。下部タブの分だけ下に余白を取る。
export function AppScreen({
  title,
  backHref,
  backLabel,
  titleTestId,
  current,
  padded = true,
  children,
}: {
  title: string;
  backHref?: string;
  backLabel?: string;
  titleTestId?: string;
  // 下部タブで強調するタブ（404 などどれにも属さない画面は省略）
  current?: NavTab;
  // false にすると本文の左右余白と幅の制限を外す（地図）
  padded?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} backHref={backHref} backLabel={backLabel} titleTestId={titleTestId} />
      {/* 下部タブ（h-16 + safe-area）の分の pb-28 を py-4 で上書きしない（cn は tailwind-merge） */}
      <main className={cn("flex flex-1 flex-col pb-28", padded && "px-4 pt-4")}>
        <div className={cn("flex w-full flex-1 flex-col gap-4", padded && "mx-auto max-w-md")}>{children}</div>
      </main>
      <BottomNav current={current} />
    </>
  );
}

// Suspense の fallback（E2E は「読み込み中…」が消えるのを待つ）
export function LoadingText({ children = "読み込み中…" }: { children?: string }) {
  return <p className="text-muted-foreground">{children}</p>;
}
