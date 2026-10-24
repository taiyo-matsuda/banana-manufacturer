import Link from "next/link";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

// 圏外で、キャッシュにない画面を開いたときに Service Worker（public/sw.js）が代わりに返す案内ページ（1-10）。
// SW の install 時にプリキャッシュされる。認証のリダイレクトはかけない（src/lib/auth/redirect.ts の PUBLIC_PATHS）。
// Supabase にはアクセスしない（静的に描画できるようにする）。下部タブは出さない（遷移先がキャッシュにあるとは限らない）。
export default function OfflinePage() {
  return (
    <div className="flex flex-1 flex-col" data-testid="offline-page">
      <PageHeader title="圏外です" />
      <main className="flex flex-1 flex-col px-4 py-4">
        <div className="mx-auto flex w-full max-w-md flex-col gap-4">
          <Card>
            <CardContent className="flex flex-col gap-3">
              <p>この画面はまだ端末に保存されていません。オンラインで開いたことのある画面は、圏外でも表示できます。</p>
              <p>未同期の記録は、電波が戻ると自動で送信されます。</p>
            </CardContent>
          </Card>
          <Button asChild size="lg" variant="outline">
            <Link href="/">ホームへ</Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
