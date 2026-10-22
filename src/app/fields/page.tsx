import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { FieldForm } from "./field-form";

// 画面 6「圃場の設定」: 一覧＋新規登録。代表点は緯度経度の入力（地図タップは 1-3 で追加）。
export default function FieldsPage() {
  return (
    <main className="flex flex-1 flex-col gap-8 px-4 py-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-8">
        <header className="flex items-center gap-3">
          <Link href="/" className="text-sm text-green-700 underline dark:text-green-400">
            ホーム
          </Link>
          <h1 className="text-xl font-semibold">圃場</h1>
        </header>

        <section aria-labelledby="fields-list-heading" className="flex flex-col gap-3">
          <h2 id="fields-list-heading" className="text-base font-medium">
            圃場の一覧
          </h2>
          <Suspense fallback={<p className="text-sm text-zinc-500">読み込み中…</p>}>
            <FieldList />
          </Suspense>
        </section>

        <section aria-labelledby="fields-new-heading" className="flex flex-col gap-3">
          <h2 id="fields-new-heading" className="text-base font-medium">
            新規登録
          </h2>
          <FieldForm />
        </section>
      </div>
    </main>
  );
}

async function FieldList() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: fields, error } = await supabase
    .from("fields")
    .select("id, name, code, center_lat, center_lng")
    .order("name");

  if (error) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        圃場の一覧を取得できませんでした（{error.message}）
      </p>
    );
  }

  if (!fields || fields.length === 0) {
    return (
      <p data-testid="fields-empty" className="text-sm text-zinc-500">
        圃場がまだありません
      </p>
    );
  }

  return (
    <ul data-testid="fields-list" className="flex flex-col divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      {fields.map((f) => (
        <li key={f.id} data-testid="field-row">
          <Link
            href={`/fields/${f.id}`}
            className="flex min-h-14 items-center justify-between gap-3 px-3 py-2"
          >
            <span className="flex flex-col">
              <span className="text-base font-medium" data-testid="field-name">
                {f.name}
              </span>
              <span className="text-xs text-zinc-500" data-testid="field-center">
                {f.center_lat}, {f.center_lng}
              </span>
            </span>
            <span
              className="rounded bg-zinc-100 px-2 py-1 font-mono text-sm dark:bg-zinc-800"
              data-testid="field-code"
            >
              {f.code}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
