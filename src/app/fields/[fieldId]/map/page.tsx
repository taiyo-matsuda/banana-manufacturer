import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { FieldMapLoader } from "./field-map-loader";

// 画面 2「圃場マップ」: 航空写真の上に株の点。配置モード（格子で配置）。
// 現在地ボタン・株のタップ（1-4）・色分け（1-5 以降）は後のタスクで追加する。
// params は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
export default function FieldMapPage({ params }: { params: Promise<{ fieldId: string }> }) {
  return (
    <main className="flex flex-1 flex-col">
      <Suspense fallback={<p className="px-4 py-6 text-sm text-zinc-500">読み込み中…</p>}>
        <FieldMap params={params} />
      </Suspense>
    </main>
  );
}

async function FieldMap({ params }: { params: Promise<{ fieldId: string }> }) {
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

  const [{ data: mats, error: matsError }, { data: cultivars, error: cultivarsError }] =
    await Promise.all([
      supabase
        .from("mats")
        .select("id, code, lat, lng")
        .eq("field_id", fieldId)
        .eq("status", "active")
        .order("code"),
      supabase.from("cultivars").select("id, name").order("name"),
    ]);

  if (matsError || cultivarsError) {
    return (
      <p role="alert" className="px-4 py-6 text-sm text-red-600 dark:text-red-400">
        地図のデータを取得できませんでした（{(matsError ?? cultivarsError)?.message}）
      </p>
    );
  }

  const defaultCultivar =
    cultivars?.find((c) => c.name === "ドワーフナムワ") ?? cultivars?.[0] ?? null;

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3">
        <Link
          href={`/fields/${field.id}`}
          className="text-sm text-green-700 underline dark:text-green-400"
        >
          圃場へ
        </Link>
        <h1 className="text-lg font-semibold" data-testid="map-field-name">
          {field.name}
        </h1>
        <span className="rounded bg-zinc-100 px-2 py-0.5 font-mono text-sm dark:bg-zinc-800">
          {field.code}
        </span>
      </header>
      <FieldMapLoader
        field={{
          id: field.id,
          name: field.name,
          code: field.code,
          centerLat: field.center_lat,
          centerLng: field.center_lng,
        }}
        mats={mats ?? []}
        cultivars={cultivars ?? []}
        defaultCultivarId={defaultCultivar?.id ?? ""}
      />
    </>
  );
}
