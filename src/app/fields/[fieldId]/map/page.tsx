import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { DeviceOwner } from "@/components/app/device-store";
import { RememberField } from "@/components/app/remember-mat";
import { createClient } from "@/lib/supabase/server";
import { defaultCultivarId } from "@/lib/mats/default-cultivar";
import { FieldMapLoader } from "./field-map-loader";

// 画面 2「圃場マップ」: 航空写真の上に株の点。配置モード（格子で配置 / 1株追加）。株のタップで株の詳細へ。
// 現在地ボタン・色分け（1-5 以降）は後のタスクで追加する。
// params は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
// ヘッダのタイトル（圃場名）と戻る先は圃場を読んでから決まるので、画面全体を Suspense の中で描く。
export default function FieldMapPage({ params }: { params: Promise<{ fieldId: string }> }) {
  return (
    <Suspense
      fallback={
        <AppScreen title="地図" current="map">
          <LoadingText />
        </AppScreen>
      }
    >
      <FieldMap params={params} />
    </Suspense>
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
        .select("id, code, lat, lng, cultivar_id, created_at")
        .eq("field_id", fieldId)
        .eq("status", "active")
        .order("code"),
      supabase.from("cultivars").select("id, name").order("name"),
    ]);

  // 品種の既定値: この圃場で最後に登録した株の品種。株がなければドワーフナムワ
  const fallbackCultivar =
    cultivars?.find((c) => c.name === "ドワーフナムワ") ?? cultivars?.[0] ?? null;
  const defaultCultivar = defaultCultivarId(mats ?? [], fallbackCultivar?.id ?? "");

  return (
    <AppScreen
      title={`${field.name}（${field.code}）`}
      titleTestId="map-field-name"
      backHref={`/fields/${field.id}`}
      backLabel="圃場"
      current="map"
      padded={false}
    >
      <DeviceOwner userId={user.id} />
      <RememberField id={field.id} name={field.name} />
      {matsError || cultivarsError ? (
        <p role="alert" className="px-4 py-6 text-destructive">
          地図のデータを取得できませんでした（{(matsError ?? cultivarsError)?.message}）
        </p>
      ) : (
        <FieldMapLoader
          field={{
            id: field.id,
            name: field.name,
            code: field.code,
            centerLat: field.center_lat,
            centerLng: field.center_lng,
          }}
          mats={(mats ?? []).map((m) => ({ id: m.id, code: m.code, lat: m.lat, lng: m.lng }))}
          cultivars={cultivars ?? []}
          defaultCultivarId={defaultCultivar}
        />
      )}
    </AppScreen>
  );
}
