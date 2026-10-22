import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "./login/actions";

// ホーム。このタスクでは組織名の表示まで。
export default function Home() {
  return (
    <main className="flex flex-1 flex-col px-4 py-6">
      <Suspense fallback={<p className="text-sm text-zinc-500">読み込み中…</p>}>
        <OrganizationHeader />
      </Suspense>
      <nav aria-label="設定" className="mt-6">
        <Link
          href="/fields"
          className="flex min-h-14 items-center rounded-lg border border-zinc-300 px-4 text-base dark:border-zinc-700"
        >
          圃場の設定
        </Link>
      </nav>
    </main>
  );
}

async function OrganizationHeader() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, organizations ( name )")
    .eq("id", user.id)
    .maybeSingle();

  const org = profile?.organizations as { name: string } | null | undefined;

  return (
    <header className="flex items-center justify-between gap-4">
      <div>
        <p className="text-xs text-zinc-500">組織</p>
        <h1 className="text-xl font-semibold" data-testid="organization-name">
          {org?.name ?? "（組織が未設定）"}
        </h1>
        {profile?.display_name && (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            {profile.display_name}
          </p>
        )}
      </div>
      <form action={logout}>
        <button
          type="submit"
          className="h-10 rounded-lg border border-zinc-300 px-3 text-sm dark:border-zinc-700"
        >
          ログアウト
        </button>
      </form>
    </header>
  );
}
