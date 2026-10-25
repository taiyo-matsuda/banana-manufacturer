import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { Button } from "@/components/ui/button";
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import { nextMatCodes } from "@/lib/mats/code";
import { suckerActionError } from "@/lib/stemEvents";
import { generationLabel } from "@/lib/stems/status";
import { createClient } from "@/lib/supabase/server";
import { TransplantForm } from "./transplant-form";

// 株分け（2-2、要件 3 章「吸芽の扱い」・UC-4、画面 3 の「株分け」）: 吸芽を掘り上げて別の位置に植え替え、新しい株にする。
// 転出先の圃場（既定: 元の株と同じ圃場。?field= で切り替える）→ その圃場の地図で空いている位置をタップ → 初期葉数 → 確定。
// 確定は Server Action（actions.ts）が RPC transplant_sucker（0011）を呼ぶ。株の作成を伴うのでオンラインのみ。
// 新しい株のコードはここで採番して画面に出し（1-3 / 1-4 と同じ: 圃場記号 + 既存の最大番号の次）、確定で渡す。
// 衝突したら Server Action が採番し直したコードを返し、画面で再試行する。
// params / searchParams は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
export default function TransplantPage({
  params,
  searchParams,
}: {
  params: Promise<{ stemId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  return (
    <Suspense
      fallback={
        <AppScreen title="株分け" current="map">
          <LoadingText />
        </AppScreen>
      }
    >
      <Transplant params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Transplant({
  params,
  searchParams,
}: {
  params: Promise<{ stemId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [{ stemId }, query] = await Promise.all([params, searchParams]);
  const supabase = await createClient();

  // 吸芽の茎と元の株（RLS により他組織の茎は見えない → notFound）。圃場の一覧も並べて取る
  const [currentUser, { data: stem }, { data: fields, error: fieldsError }] = await Promise.all([
    getCurrentUser(),
    supabase
      .from("stems")
      .select("id, generation, status, started_at, mat:mats!stems_mat_id_fkey ( id, code, field_id )")
      .eq("id", stemId)
      .maybeSingle(),
    supabase.from("fields").select("id, name, code, center_lat, center_lng").order("name"),
  ]);
  userOrRedirect(currentUser);
  if (!stem) notFound();
  const mat = stem.mat as unknown as { id: string; code: string; field_id: string } | null;
  if (!mat) notFound();

  const back = { backHref: `/mats/${mat.id}`, backLabel: `株 ${mat.code}` };
  const stemName = `株 ${mat.code} の${generationLabel(stem.generation)}（第 ${stem.generation} 世代）の吸芽`;

  const blocked = suckerActionError(stem.status, "sucker_transplanted");
  if (blocked) {
    return (
      <AppScreen title="株分け" {...back} current="map">
        <p className="text-muted-foreground" data-testid="transplant-blocked">
          {blocked}
        </p>
        <Button asChild variant="outline">
          <Link href={`/mats/${mat.id}`}>株 {mat.code} へ戻る</Link>
        </Button>
      </AppScreen>
    );
  }
  if (fieldsError || !fields) {
    return (
      <AppScreen title="株分け" {...back} current="map">
        <p role="alert" className="text-destructive">
          圃場を取得できませんでした（{fieldsError?.message}）
        </p>
      </AppScreen>
    );
  }

  const requested = typeof query.field === "string" ? query.field : null;
  const target = fields.find((f) => f.id === requested) ?? fields.find((f) => f.id === mat.field_id) ?? fields[0];
  if (!target) notFound();

  // 転出先の圃場の株（地図に出すのは撤去していない株。コードの採番は撤去した株も含めて最大の次）
  const { data: targetMats, error: matsError } = await supabase
    .from("mats")
    .select("id, code, lat, lng, status")
    .eq("field_id", target.id)
    .order("code");
  if (matsError) {
    return (
      <AppScreen title="株分け" {...back} current="map">
        <p role="alert" className="text-destructive">
          転出先の株を取得できませんでした（{matsError.message}）
        </p>
      </AppScreen>
    );
  }
  const proposedCode = nextMatCodes(
    target.code,
    (targetMats ?? []).map((m) => m.code),
    1,
  )[0];

  return (
    <AppScreen title="株分け" {...back} current="map">
      <p data-testid="transplant-source">{stemName}を、別の位置に植え替えて新しい株にします</p>
      <TransplantForm
        stemId={stem.id}
        fields={fields.map((f) => ({ id: f.id, name: f.name, code: f.code }))}
        target={{ id: target.id, name: target.name, code: target.code, centerLat: target.center_lat, centerLng: target.center_lng }}
        mats={(targetMats ?? []).filter((m) => m.status === "active").map((m) => ({ id: m.id, code: m.code, lat: m.lat, lng: m.lng }))}
        proposedCode={proposedCode}
      />
    </AppScreen>
  );
}
