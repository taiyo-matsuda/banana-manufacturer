"use client";

import { useRef, useState } from "react";
import { FormField } from "@/components/app/form-field";
import { NumberField } from "@/components/app/number-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  correctableSeverities,
  correctedTimestamp,
  correctionAvailability,
  type CorrectionForm,
  correctionKey,
  type CorrectionOriginal,
  initialCorrectionForm,
  parseEventCorrection,
  parseObservationCorrection,
} from "@/lib/corrections";
import { useOnline } from "@/lib/offline/use-online";
import { DAMAGE_KIND_LABELS, DAMAGE_KINDS, DAMAGE_SEVERITY_LABELS, todayJst } from "@/lib/stemEvents";
import { formatDateTime, type HistoryEntry } from "@/lib/stems/records";
import { correctObservation, correctStemEvent } from "./actions";

// 履歴の行の「訂正」ボタンと入力ダイアログ（2-6、要件 5.5）。
// - 元の値を初期値にして、日付と payload の数値だけを直す（イベントの種類は変えられない）。削除の操作は置かない
// - 確定すると Server Action → RPC が新しい行を追加し、元の行の superseded_by に新しい行の id を入れる。
//   画面は revalidatePath で取り直し、元の行は打ち消し線＋「訂正済み → 新しい値」になる
// - 新しい行の id はダイアログを開いたときに 1 つ採番し、同じ内容の再送（応答が届かなかった場合）は同じ id で送る
//   （RPC は同じ id の行があれば何もしない）。内容を変えたとき・サーバーが拒否したときだけ採番し直す
//   （最初の送信が実は届いていても、元の行が訂正済みになっているので 2 件目は RPC が拒否する）
// - 入力は React の state で持ち、Server Action を関数として呼ぶ（エラーで戻っても入力が残る）
// - オンライン前提。圏外・未同期の行はボタンを無効にして理由を出す
export function CorrectRecord({ entry }: { entry: HistoryEntry }) {
  const online = useOnline();
  // 茎の画面の履歴からだけ呼ばれる（StemHistory の correctable）
  const availability = correctionAvailability({ ...entry, targetType: "stem" }, online);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CorrectionForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submission = useRef<{ id: string; key: string | null } | null>(null);

  if (!availability.show || entry.kind === "photo") return null;

  const original: CorrectionOriginal & { id: string } = {
    id: entry.id,
    kind: entry.kind,
    type: entry.type,
    at: entry.at.toISOString(),
    value: entry.value,
    payload: entry.payload ?? null,
  };

  const openDialog = () => {
    setForm(initialCorrectionForm(original));
    setError(null);
    submission.current = { id: crypto.randomUUID(), key: null };
    setOpen(true);
  };

  const set = (name: keyof CorrectionForm) => (value: string) => {
    setError(null);
    setForm((f) => (f ? { ...f, [name]: value } : f));
  };

  const submit = async () => {
    if (pending || !form || !online) return;
    const now = new Date();
    const parsed = original.kind === "observation" ? parseObservationCorrection(original, form, now) : parseEventCorrection(original, form, now);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const at = correctedTimestamp(parsed.value.date, original.at, now);
    const content = "payload" in parsed.value ? { at, payload: parsed.value.payload } : { at, value: parsed.value.value };
    const key = correctionKey(original, content);
    if (!submission.current || (submission.current.key !== null && submission.current.key !== key)) {
      submission.current = { id: crypto.randomUUID(), key };
    }
    submission.current.key = key;
    const newId = submission.current.id;

    setPending(true);
    try {
      const result =
        "payload" in parsed.value
          ? await correctStemEvent({ newId, oldId: original.id, type: original.type, occurredAt: at, payload: parsed.value.payload })
          : await correctObservation({ newId, oldId: original.id, type: original.type, value: parsed.value.value, observedAt: at });
      if (!result.ok) {
        // サーバーが拒否した（何も記録されていない）。直して送り直すときは新しい id にする
        submission.current = { id: crypto.randomUUID(), key: null };
        setError(result.error);
        return;
      }
      submission.current = null;
      setOpen(false);
    } catch (err) {
      // 通信エラー: サーバーで記録済みかもしれないので id は保持する（同じ内容の再送は 1 件になる）
      console.error("correct record failed", err);
      setError("訂正を保存できませんでした。通信を確かめて再度お試しください");
    } finally {
      setPending(false);
    }
  };

  const today = todayJst();
  const p = entry.payload ?? {};

  return (
    <>
      <span className="flex flex-col items-end gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={openDialog}
          disabled={!availability.enabled}
          data-testid="correct-open"
        >
          訂正
        </Button>
        {!availability.enabled && (
          <span className="max-w-40 text-right text-xs text-muted-foreground" data-testid="correct-disabled-reason">
            {availability.reason}
          </span>
        )}
      </span>

      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent
          showCloseButton={false}
          // 開いた瞬間に日付入力へフォーカスが入ると、iPhone では日付ピッカーが勝手に開くので、自動フォーカスしない
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="max-h-[90vh] overflow-y-auto"
          data-testid="correct-dialog"
          data-kind={entry.kind}
          data-type={entry.type}
        >
          {form && (
            <form
              className="flex flex-col gap-4"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <DialogHeader>
                <DialogTitle>{entry.label}を訂正</DialogTitle>
                <DialogDescription>
                  元の記録（{entry.valueText ? `${entry.valueText}・` : ""}
                  {formatDateTime(entry.at)}）は消さずに「訂正済み」として履歴に残ります
                </DialogDescription>
              </DialogHeader>

              <FormField id="correct-date" label="日付">
                <Input
                  id="correct-date"
                  type="date"
                  value={form.date}
                  max={today}
                  onChange={(e) => set("date")(e.target.value)}
                  data-testid="correct-date"
                />
              </FormField>

              {entry.kind === "observation" && (
                <NumberField
                  id="correct-value"
                  label={entry.label}
                  unit={entry.type === "pseudostem_girth_cm" || entry.type === "height_cm" ? "cm" : "枚"}
                  inputMode={entry.type === "pseudostem_girth_cm" || entry.type === "height_cm" ? "decimal" : "numeric"}
                  min={0}
                  step={entry.type === "pseudostem_girth_cm" || entry.type === "height_cm" ? 0.1 : 1}
                  value={form.value}
                  onChange={(e) => set("value")(e.target.value)}
                  data-testid="correct-value"
                />
              )}

              {entry.type === "bud_emerged" && (
                <>
                  <FormField id="correct-earliest-at" label="前回訪問日" hint="蕾がまだ無かった日。空でもよい">
                    <Input
                      id="correct-earliest-at"
                      type="date"
                      value={form.earliestAt}
                      onChange={(e) => set("earliestAt")(e.target.value)}
                      data-testid="correct-earliest-at"
                    />
                  </FormField>
                  <NumberField
                    id="correct-leaves-current"
                    label="生葉数"
                    unit="枚"
                    min={0}
                    step={1}
                    value={form.leavesCurrent}
                    onChange={(e) => set("leavesCurrent")(e.target.value)}
                    data-testid="correct-leaves-current"
                  />
                  <NumberField
                    id="correct-girth-cm"
                    label="偽茎周囲長（地上 1m）"
                    unit="cm"
                    inputMode="decimal"
                    min={0}
                    step={0.1}
                    value={form.girthCm}
                    onChange={(e) => set("girthCm")(e.target.value)}
                    data-testid="correct-girth-cm"
                  />
                  {typeof p.cumulative_leaves === "number" && (
                    <p className="text-sm text-muted-foreground">
                      出蕾時の累計葉数（{p.cumulative_leaves} 枚）は出蕾時点の記録として残し、訂正では変わりません
                    </p>
                  )}
                </>
              )}

              {entry.type === "hands_counted" && (
                <NumberField
                  id="correct-hands"
                  label="段数"
                  unit="段"
                  min={1}
                  step={1}
                  value={form.hands}
                  onChange={(e) => set("hands")(e.target.value)}
                  data-testid="correct-hands"
                />
              )}

              {entry.type === "harvested" && (
                <NumberField
                  id="correct-weight-kg"
                  label="果房重量"
                  unit="kg"
                  hint="小数 1 桁"
                  inputMode="decimal"
                  min={0}
                  step={0.1}
                  value={form.weightKg}
                  onChange={(e) => set("weightKg")(e.target.value)}
                  data-testid="correct-weight-kg"
                />
              )}

              {entry.type === "leaves_removed" && (
                <NumberField
                  id="correct-count"
                  label="除去した枚数"
                  unit="枚"
                  min={1}
                  step={1}
                  value={form.count}
                  onChange={(e) => set("count")(e.target.value)}
                  data-testid="correct-count"
                />
              )}

              {entry.type === "damage" && (
                <>
                  <FormField id="correct-kind" label="種類">
                    <NativeSelect id="correct-kind" value={form.kind} onChange={(e) => set("kind")(e.target.value)} data-testid="correct-kind">
                      {DAMAGE_KINDS.map((k) => (
                        <NativeSelectOption key={k} value={k}>
                          {DAMAGE_KIND_LABELS[k]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </FormField>
                  <FormField
                    id="correct-severity"
                    label="程度"
                    hint={
                      p.severity === "lost"
                        ? "「喪失」の被害は程度を変えられません（日付と種類だけ訂正できます）"
                        : "訂正で「喪失」にはできません（茎の状態は変えられません）"
                    }
                  >
                    <NativeSelect
                      id="correct-severity"
                      value={form.severity}
                      onChange={(e) => set("severity")(e.target.value)}
                      data-testid="correct-severity"
                    >
                      {correctableSeverities(p.severity).map((s) => (
                        <NativeSelectOption key={s} value={s}>
                          {DAMAGE_SEVERITY_LABELS[s]}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </FormField>
                </>
              )}

              {!online && (
                <Alert variant="warning">
                  <AlertDescription>訂正は電波のあるところで行ってください（端末に貯めません）</AlertDescription>
                </Alert>
              )}
              {error && (
                <Alert variant="destructive" data-testid="correct-error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <DialogFooter className="flex-row gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="flex-1"
                  onClick={() => setOpen(false)}
                  disabled={pending}
                  data-testid="correct-cancel"
                >
                  やめる
                </Button>
                <Button type="submit" size="lg" className="flex-1" disabled={pending || !online} data-testid="correct-submit">
                  {pending ? "保存中…" : "訂正する"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
