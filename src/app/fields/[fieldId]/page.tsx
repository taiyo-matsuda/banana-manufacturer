import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// 圃場の詳細。このタスクではプレースホルダー（名前・記号・代表点の表示のみ）。
// 土壌分析の入力、地図（1-3）は後のタスクで追加する。
// params は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
// Promise のまま Suspense 内の子に渡し、そこで await する。
export default function FieldDetailPage({
  params,
}: {
  params: Promise<{ fieldId: string }>;
}) {
  return (
    <main className="flex flex-1 flex-col gap-6 px-4 py-6">
      <div className="mx-auto flex w-full max-w-md flex-col gap-6">
        <Link href="/fields" className="text-sm text-green-700 underline dark:text-green-400">
          圃場の一覧へ
        </Link>
        <Suspense fallback={<p className="text-sm text-zinc-500">読み込み中…</p>}>
          <FieldDetail params={params} />
        </Suspense>
      </div>
    </main>
  );
}

async function FieldDetail({ params }: { params: Promise<{ fieldId: string }> }) {
  const { fieldId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: field } = await supabase
    .from("fields")
    .select("id, name, code, center_lat, center_lng")
    .eq("id", fieldId)
    .maybeSingle();
  if (!field) notFound();

  return (
    <article className="flex flex-col gap-2">
      <p className="text-xs text-zinc-500">圃場</p>
      <h1 className="text-xl font-semibold" data-testid="field-detail-name">
        {field.name}
      </h1>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-zinc-500">圃場記号</dt>
        <dd className="font-mono">{field.code}</dd>
        <dt className="text-zinc-500">代表点</dt>
        <dd>
          {field.center_lat}, {field.center_lng}
        </dd>
      </dl>
      <Link
        href={`/fields/${field.id}/map`}
        className="mt-4 flex min-h-14 items-center rounded-lg border border-zinc-300 px-4 text-base dark:border-zinc-700"
      >
        地図（株の配置）
      </Link>
    </article>
  );
}
