import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import { defaultFertilizerUnit, fertilizerSuggestions, formatAmount } from "@/lib/fertilize";
import { RECOMMENDATION_PARAMS_COLUMNS, type RecommendationParamsRow, resolveRecommendationSettings } from "@/lib/recommendations/settings";
import { todayJst } from "@/lib/stemEvents";
import { createClient } from "@/lib/supabase/server";
import { FertilizeForm } from "./fertilize-form";

// 画面 5「施肥の一括入力」（2-4、要件 4.4・UC-5）: 圃場の撤去していない全株に同じ施肥を入れ、例外の株だけ量を変える・外す。
// 確定すると株ごとに fertilized イベント（同じ batch_id）を作る（actions.ts）。オンライン前提。
// 3-5: ?mat=<株の id>（提案「収穫後の追肥」の「実施した」）なら、その株だけを選び、量に圃場の標準量（あれば）を入れて開く。
// 確定の後の提案の評価で、その株の提案が done になる（actions.ts）。
// params は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

export default function FertilizePage({ params, searchParams }: { params: Promise<{ fieldId: string }>; searchParams: SearchParams }) {
  return (
    <Suspense
      fallback={
        <AppScreen title="施肥の記録" current="settings">
          <LoadingText />
        </AppScreen>
      }
    >
      <Fertilize params={params} searchParams={searchParams} />
    </Suspense>
  );
}

// 肥料名の候補を作るために読む直近の fertilized イベントの数。
// 1 回の確定で株の数だけイベントができるので、候補 20 件を拾えるよう多めに読む（payload の 2 項目だけ）
const RECENT_FERTILIZED_ROWS = 2000;

async function Fertilize({ params, searchParams }: { params: Promise<{ fieldId: string }>; searchParams: SearchParams }) {
  const [{ fieldId }, query] = await Promise.all([params, searchParams]);
  const onlyMat = typeof query.mat === "string" ? query.mat : null;
  const supabase = await createClient();
  // RLS により他組織の圃場・株・イベントは見えない
  const [currentUser, { data: field }, { data: mats, error: matsError }, { data: recent }, { data: recParams }] = await Promise.all([
    getCurrentUser(),
    supabase.from("fields").select("id, name").eq("id", fieldId).maybeSingle(),
    supabase.from("mats").select("id, code").eq("field_id", fieldId).neq("status", "removed").order("code"),
    supabase
      .from("events")
      .select("fertilizer:payload->>fertilizer, unit:payload->>unit")
      .eq("type", "fertilized")
      .order("created_at", { ascending: false })
      .limit(RECENT_FERTILIZED_ROWS),
    onlyMat
      ? supabase.from("field_recommendation_params").select(RECOMMENDATION_PARAMS_COLUMNS).eq("field_id", fieldId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  userOrRedirect(currentUser);
  if (!field) notFound();

  const payloads = (recent ?? []) as { fertilizer: unknown; unit: unknown }[];
  const matList = (mats ?? []).map((m) => ({ id: m.id as string, code: m.code as string }));
  const onlyMatId = onlyMat && matList.some((m) => m.id === onlyMat) ? onlyMat : null;
  const standard = onlyMatId ? resolveRecommendationSettings(recParams as RecommendationParamsRow | null).standardAmount : null;

  return (
    <AppScreen title="施肥の記録" backHref={`/fields/${field.id}`} backLabel="圃場" current="settings">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">圃場</p>
        <p className="text-lg font-semibold break-words" data-testid="fertilize-field-name">
          {field.name}
        </p>
      </div>
      {matsError ? (
        <p role="alert" className="text-destructive">
          株を取得できませんでした（{matsError.message}）
        </p>
      ) : (
        <FertilizeForm
          // ?mat= が変わったら（クライアント遷移で別の株の提案から来たとき）選択を作り直す
          key={onlyMatId ?? "all"}
          fieldId={field.id}
          mats={matList}
          suggestions={fertilizerSuggestions(payloads)}
          defaultUnit={standard?.unit ?? defaultFertilizerUnit(payloads)}
          today={todayJst()}
          onlyMatId={onlyMatId}
          initialAmount={standard ? formatAmount(standard.amount) : ""}
        />
      )}
    </AppScreen>
  );
}
