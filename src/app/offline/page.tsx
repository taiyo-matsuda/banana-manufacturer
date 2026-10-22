import Link from "next/link";

// 圏外で、キャッシュにない画面を開いたときに Service Worker（public/sw.js）が代わりに返す案内ページ（1-10）。
// SW の install 時にプリキャッシュされる。認証のリダイレクトはかけない（src/lib/auth/redirect.ts の PUBLIC_PATHS）。
// Supabase にはアクセスしない（静的に描画できるようにする）。
export default function OfflinePage() {
  return (
    <main className="flex flex-1 flex-col px-4 py-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4" data-testid="offline-page">
        <h1 className="text-xl font-semibold">圏外です</h1>
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          この画面はまだ端末に保存されていません。オンラインで開いたことのある画面は、圏外でも表示できます。
        </p>
        <p className="text-sm text-zinc-700 dark:text-zinc-300">
          未同期の記録は、電波が戻ると自動で送信されます。
        </p>
        <Link
          href="/"
          className="flex min-h-14 items-center justify-center rounded-lg border border-zinc-300 px-4 text-base dark:border-zinc-700"
        >
          ホームへ
        </Link>
      </div>
    </main>
  );
}
