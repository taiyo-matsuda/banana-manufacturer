"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { CloudLightningIcon } from "lucide-react";
import { FormField } from "@/components/app/form-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  type DamageErrors,
  type DamageTargetType,
  LOST_NOT_ALLOWED_HINT,
  MAX_DAMAGE_NOTE_LENGTH,
  parseDamageDate,
  parseDamageKind,
  parseDamageNote,
  parseTargetDamageSeverity,
  TARGET_DAMAGE_SEVERITIES,
  type TargetDamageInput,
  targetDamageKey,
} from "@/lib/damage";
import { useOnline } from "@/lib/offline/use-online";
import { DAMAGE_KIND_LABELS, DAMAGE_KINDS, DAMAGE_SEVERITY_LABELS } from "@/lib/stemEvents";

export type RecordTargetDamage = (
  input: TargetDamageInput,
) => Promise<{ ok: true; eventId: string } | { ok: false; errors: DamageErrors }>;

const OFFLINE_MESSAGE = "圃場・株の被害は電波のあるところで記録してください（端末に貯めません）";

// 圃場・株の被害（2-5、要件 4.3・UC-6）の「被害を記録」ボタンと入力ダイアログ。圃場の詳細と株の詳細で共通。
// - 種類・程度は茎の被害（1-8）と同じ定義。程度に「喪失」は出さない（近くに案内。Server Action も拒否する）
// - 入力（日付・種類・程度・メモ）は React の state で持ち、Server Action（props の action）を関数として呼ぶ。
//   エラーで戻っても入力は消えない（React 19 のフォームリセットを受けない）
// - event id は確定ごとに 1 つ。保存が成功するまで保持し、同じ内容の再送（応答が届かなかった場合）は同じ id で送る
//   （サーバーは同じ id があれば insert しない）。内容が変わったとき・成功したとき・検証エラーで戻ったときだけ採番し直す
// - オンライン前提（outbox に積まない）。圏外なら保存ボタンを無効にして理由を出す
// - 圃場の被害は保存の後に「この圃場の株にも記録する」（bulkHrefBase + event id）へ進める
export function TargetDamageRecord({
  targetType,
  targetId,
  today,
  action,
  bulkHrefBase,
}: {
  targetType: DamageTargetType;
  targetId: string;
  today: string;
  action: RecordTargetDamage;
  bulkHrefBase?: string;
}) {
  const online = useOnline();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(today);
  const [kind, setKind] = useState("");
  const [severity, setSeverity] = useState("");
  const [note, setNote] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<DamageErrors>({});
  const [pending, setPending] = useState(false);
  // 圃場: 保存した圃場の被害の id（ダイアログに完了と「株にも記録する」を出す）/ 株: 完了の表示
  const [savedId, setSavedId] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const submission = useRef<{ id: string; key: string } | null>(null);

  const targetLabel = targetType === "field" ? "圃場" : "株";
  const now = new Date(`${today}T12:00:00+09:00`);
  const dateCheck = parseDamageDate(date, now);
  const kindCheck = parseDamageKind(kind);
  const severityCheck = parseTargetDamageSeverity(severity);
  const noteCheck = parseDamageNote(note);
  const errors = {
    date: serverErrors.date ?? (showErrors && !dateCheck.ok ? dateCheck.error : null),
    kind: serverErrors.kind ?? (showErrors && !kindCheck.ok ? kindCheck.error : null),
    severity: serverErrors.severity ?? (showErrors && !severityCheck.ok ? severityCheck.error : null),
    note: serverErrors.note ?? (showErrors && !noteCheck.ok ? noteCheck.error : null),
  };
  const valid = dateCheck.ok && kindCheck.ok && severityCheck.ok && noteCheck.ok;

  const edit = (set: (v: string) => void) => (v: string) => {
    setServerErrors({});
    set(v);
  };

  const openDialog = () => {
    setSavedId(null);
    setNotice(false);
    setOpen(true);
  };

  const submit = async () => {
    setShowErrors(true);
    if (pending || !online || !valid) return;
    const content = { targetType, targetId, date, kind, severity, note };
    const key = targetDamageKey(content);
    if (submission.current?.key !== key) submission.current = { id: crypto.randomUUID(), key };
    setPending(true);
    try {
      const result = await action({ eventId: submission.current.id, ...content });
      if (!result.ok) {
        // 検証エラー（何も記録されていない）。直して送り直すときは新しい id にする
        submission.current = null;
        setServerErrors(result.errors);
        return;
      }
      submission.current = null;
      setServerErrors({});
      setShowErrors(false);
      setKind("");
      setSeverity("");
      setNote("");
      setDate(today);
      if (targetType === "field") {
        setSavedId(result.eventId);
      } else {
        setOpen(false);
        setNotice(true);
      }
    } catch (err) {
      // 通信エラー: サーバーで記録済みかもしれないので id は保持する（同じ内容の再送は 1 件になる）
      console.error("record damage failed", err);
      setServerErrors({ form: "保存できませんでした。通信を確かめて再度お試しください" });
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      {notice && (
        <Alert variant="success" data-testid="damage-notice">
          <AlertDescription>被害を記録しました</AlertDescription>
        </Alert>
      )}
      <Button type="button" size="lg" variant="outline" onClick={openDialog} data-testid="damage-open">
        <CloudLightningIcon aria-hidden="true" />
        被害を記録
      </Button>

      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent
          showCloseButton={false}
          // 開いた瞬間に日付入力へフォーカスが入ると、iPhone では日付ピッカーが勝手に開くので、自動フォーカスしない
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="max-h-[90vh] overflow-y-auto"
          data-testid="damage-dialog"
          data-target-type={targetType}
        >
          {savedId ? (
            <div className="flex flex-col gap-4" data-testid="damage-done">
              <DialogHeader>
                <DialogTitle>{targetLabel}の被害を記録しました</DialogTitle>
                <DialogDescription>
                  台風の後などで株ごとにも残したいときは、この圃場の株を選んで同じ内容を記録できます（任意）
                </DialogDescription>
              </DialogHeader>
              {bulkHrefBase && (
                <Button asChild size="lg">
                  <Link href={`${bulkHrefBase}${savedId}`} data-testid="damage-bulk-link">
                    この圃場の株にも記録する
                  </Link>
                </Button>
              )}
              <Button type="button" variant="outline" size="lg" onClick={() => setOpen(false)} data-testid="damage-close">
                閉じる
              </Button>
            </div>
          ) : (
            <form
              className="flex flex-col gap-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
              data-testid="damage-form"
            >
              <DialogHeader>
                <DialogTitle>{targetLabel}の被害を記録</DialogTitle>
                <DialogDescription>
                  {targetType === "field" ? "圃場全体に受けた被害を記録します" : "この株に受けた被害を記録します"}
                </DialogDescription>
              </DialogHeader>

              <FormField id="damage-date" label="日付" error={errors.date}>
                <Input
                  id="damage-date"
                  type="date"
                  value={date}
                  max={today}
                  onChange={(e) => edit(setDate)(e.target.value)}
                  aria-invalid={errors.date ? true : undefined}
                  data-testid="damage-date"
                />
              </FormField>
              <FormField id="damage-kind" label="種類" error={errors.kind}>
                <NativeSelect
                  id="damage-kind"
                  value={kind}
                  onChange={(e) => edit(setKind)(e.target.value)}
                  aria-invalid={errors.kind ? true : undefined}
                  data-testid="damage-kind"
                >
                  <NativeSelectOption value="">選んでください</NativeSelectOption>
                  {DAMAGE_KINDS.map((k) => (
                    <NativeSelectOption key={k} value={k}>
                      {DAMAGE_KIND_LABELS[k]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField id="damage-severity" label="程度" hint={LOST_NOT_ALLOWED_HINT} error={errors.severity}>
                <NativeSelect
                  id="damage-severity"
                  value={severity}
                  onChange={(e) => edit(setSeverity)(e.target.value)}
                  aria-invalid={errors.severity ? true : undefined}
                  data-testid="damage-severity"
                >
                  <NativeSelectOption value="">選んでください</NativeSelectOption>
                  {TARGET_DAMAGE_SEVERITIES.map((s) => (
                    <NativeSelectOption key={s} value={s}>
                      {DAMAGE_SEVERITY_LABELS[s]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </FormField>
              <FormField id="damage-note" label="メモ（任意）" hint="例: 台風 14 号" error={errors.note}>
                <Textarea
                  id="damage-note"
                  value={note}
                  maxLength={MAX_DAMAGE_NOTE_LENGTH}
                  onChange={(e) => edit(setNote)(e.target.value)}
                  aria-invalid={errors.note ? true : undefined}
                  className="min-h-16"
                  data-testid="damage-note"
                />
              </FormField>

              {serverErrors.form && (
                <Alert variant="destructive" data-testid="damage-error">
                  <AlertDescription>{serverErrors.form}</AlertDescription>
                </Alert>
              )}
              {!online && (
                <p className="text-sm text-muted-foreground" data-testid="damage-offline">
                  {OFFLINE_MESSAGE}
                </p>
              )}

              <DialogFooter className="flex-row gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="flex-1"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                  data-testid="damage-cancel"
                >
                  やめる
                </Button>
                <Button type="submit" size="lg" className="flex-1" disabled={pending || !online} data-testid="damage-submit">
                  {pending ? "記録中…" : "記録する"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
