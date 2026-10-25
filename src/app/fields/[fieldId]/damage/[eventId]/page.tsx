import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AppScreen, LoadingText } from "@/components/app/app-screen";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCurrentUser, userOrRedirect } from "@/lib/auth/current-user";
import { bulkDamageCandidates, checkFieldDamageEvent, type FieldDamageEvent } from "@/lib/damage";
import { damageKindLabel, damageSeverityLabel, todayJst } from "@/lib/stemEvents";
import { UUID_PATTERN } from "@/lib/fertilize";
import { createClient } from "@/lib/supabase/server";
import { BulkDamageForm } from "./bulk-damage-form";

// 圃場の被害から株へ一括（2-5、要件 4.3・UC-6）: 圃場の被害（target_type=field）を保存した後に任意で進む画面。
// 圃場の撤去していない株の一覧（施肥 2-4 と共通の部品）で対象を選び、同じ内容（日付・種類・程度・メモ）の
// damage イベント（target_type=mat、payload に field_event_id）を株ごとに作る（actions.ts の recordBulkMatDamage）。
// この圃場の被害から既に記録した株は候補に出さない（二重に記録しない）。オンライン前提。
// params は Suspense の外で await しない（cacheComponents の静的シェル検証でビルドが落ちる）。
export default function BulkDamagePage({ params }: { params: Promise<{ fieldId: string; eventId: string }> }) {
  return (
    <Suspense
      fallback={
        <AppScreen title="株にも被害を記録" current="settings">
          <LoadingText />
        </AppScreen>
      }
    >
      <BulkDamage params={params} />
    </Suspense>
  );
}

async function BulkDamage({ params }: { params: Promise<{ fieldId: string; eventId: string }> }) {
  const { fieldId, eventId } = await params;
  // 形式の違う id は DB に問い合わせずに 404（uuid 列に渡すと 400 になる）
  if (!UUID_PATTERN.test(fieldId) || !UUID_PATTERN.test(eventId)) notFound();
  const supabase = await createClient();
  // RLS により他組織の圃場・株・イベントは見えない
  const [currentUser, { data: field }, { data: event }, { data: mats, error: matsError }, { data: recorded, error: recordedError }] =
    await Promise.all([
      getCurrentUser(),
      supabase.from("fields").select("id, name").eq("id", fieldId).maybeSingle(),
      supabase
        .from("events")
        .select("id, type, target_type, target_id, occurred_at, payload, note, superseded_by")
        .eq("id", eventId)
        .maybeSingle(),
      supabase.from("mats").select("id, code, status").eq("field_id", fieldId).neq("status", "removed").order("code"),
      // この圃場の被害から既に記録した株
      supabase
        .from("events")
        .select("target_id")
        .eq("type", "damage")
        .eq("target_type", "mat")
        .eq("payload->>field_event_id", eventId),
    ]);
  userOrRedirect(currentUser);
  if (!field) notFound();

  const fieldEvent = event as FieldDamageEvent | null;
  const check = checkFieldDamageEvent(fieldEvent, field.id);
  const backHref = `/fields/${field.id}`;

  if (!check.ok || !fieldEvent) {
    return (
      <AppScreen title="株にも被害を記録" backHref={backHref} backLabel="圃場" current="settings">
        <Alert variant="destructive" data-testid="damage-bulk-unavailable">
          <AlertDescription>{check.ok ? "圃場の被害の記録が見つかりません" : check.error}</AlertDescription>
        </Alert>
      </AppScreen>
    );
  }

  const recordedIds = new Set((recorded ?? []).map((r) => r.target_id as string));
  const allMats = (mats ?? []).map((m) => ({ id: m.id as string, code: m.code as string, status: m.status as string }));
  const candidates = bulkDamageCandidates(allMats, recordedIds);
  const alreadyCount = allMats.length - candidates.length;

  return (
    <AppScreen title="株にも被害を記録" backHref={backHref} backLabel="圃場" current="settings">
      <Card>
        <CardHeader>
          <p className="text-sm text-muted-foreground">圃場の被害（この内容で株にも記録します）</p>
          <CardTitle className="break-words" data-testid="damage-bulk-field-name">
            {field.name}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1" data-testid="damage-bulk-content">
            <dt className="text-muted-foreground">日付</dt>
            <dd data-testid="damage-bulk-date">{todayJst(new Date(fieldEvent.occurred_at))}</dd>
            <dt className="text-muted-foreground">種類</dt>
            <dd data-testid="damage-bulk-kind">{damageKindLabel(check.kind)}</dd>
            <dt className="text-muted-foreground">程度</dt>
            <dd data-testid="damage-bulk-severity">{damageSeverityLabel(check.severity)}</dd>
            {fieldEvent.note && (
              <>
                <dt className="text-muted-foreground">メモ</dt>
                <dd className="break-words" data-testid="damage-bulk-note">
                  {fieldEvent.note}
                </dd>
              </>
            )}
          </dl>
        </CardContent>
      </Card>
      {matsError || recordedError ? (
        <p role="alert" className="text-destructive">
          株を取得できませんでした（{(matsError ?? recordedError)?.message}）
        </p>
      ) : (
        <BulkDamageForm
          fieldId={field.id}
          fieldEventId={fieldEvent.id}
          mats={candidates.map((m) => ({ id: m.id, code: m.code }))}
          alreadyCount={alreadyCount}
        />
      )}
    </AppScreen>
  );
}
