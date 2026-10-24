import Link from "next/link";
import { ChevronLeftIcon, HomeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

// 画面ヘッダ（UX-1）: 左「← 戻る」、中央タイトル、右「ホーム」。
// 未同期件数のチップは layout.tsx の <SyncStatus>（1 つだけ）が、このヘッダの右側（ホームの左）に重ねて表示する。
// クライアント遷移では前の画面の DOM が非表示のまま残る（Next.js）ので、画面ごとに置くとチップが二重になるため。
// その分の幅をここで空けておく（チップの実際の幅は SyncStatus が CSS 変数 --sync-chip-w に書く。未設定なら 6rem）。
// どの画面からもホームへは 1 タップ（このホーム、または下部タブ）。

export function PageHeader({
  title,
  backHref,
  backLabel = "戻る",
  titleTestId = "page-title",
}: {
  title: string;
  // 省略するとホームなど「戻る先がない」画面
  backHref?: string;
  backLabel?: string;
  titleTestId?: string;
}) {
  return (
    <header
      data-testid="page-header"
      className="sticky top-0 z-40 h-14 border-b bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80"
    >
      <div className="flex h-full items-center gap-1 pr-2 pl-1">
        {backHref ? (
          <Button asChild variant="ghost" size="sm" className="shrink-0 px-2">
            <Link href={backHref} data-testid="back-link">
              <ChevronLeftIcon aria-hidden="true" />
              {backLabel}
            </Link>
          </Button>
        ) : (
          <span className="w-2" aria-hidden="true" />
        )}
        <h1 className="min-w-0 flex-1 truncate text-lg font-semibold" data-testid={titleTestId}>
          {title}
        </h1>
        {/* 未同期チップの場所（layout の SyncStatus が重なる） */}
        <span className="w-(--sync-chip-w,6rem) shrink-0" aria-hidden="true" data-testid="sync-slot" />
        <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
          <Link href="/" aria-label="ホーム" data-testid="home-link">
            <HomeIcon aria-hidden="true" />
          </Link>
        </Button>
      </div>
    </header>
  );
}
