"use client";

import { useState } from "react";
import { NumberField } from "@/components/app/number-field";
import { RecordButton } from "@/components/app/record-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { enqueueLeavesRemoved, enqueueObservation } from "@/lib/offline/enqueue";
import { parseLeavesCurrent, parseLeavesNew, parseLeavesRemoved } from "@/lib/stems/records";

// 茎の記録入力（画面 4）。保存ボタンはなく、タップ＝記録。
// 記録は端末の outbox に積む（1-9。オンラインでも同じ経路）。画面は outbox の購読で即座に反映され、同期後にサーバーの最新に揃う。
// 観測（leaves_new / leaves_current）は確認なし。イベント（枯葉処理）は confirm を出す。
// 記録を編集・削除する UI は置かない。
// Server Action を使わないので、フォーム送信後の入力のクリアは自前で行う（React 19 の自動リセットには頼らない）。
export function LeafRecord({ stemId, userId }: { stemId: string; userId: string }) {
  return (
    <>
      <LeavesNewForm stemId={stemId} userId={userId} />
      <LeavesRemovedForm stemId={stemId} userId={userId} />
      <LeavesCurrentForm stemId={stemId} userId={userId} />
    </>
  );
}

function ErrorText({ id, error }: { id: string; error: string | null }) {
  if (!error) return null;
  return (
    <Alert variant="destructive" data-testid={id}>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

const SAVE_FAILED = "端末に保存できませんでした。時間をおいて再度お試しください";

// 送信中フラグとエラー。run は端末への保存（outbox）なので圏外でも成功する
function useRecord() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const run = async (work: () => Promise<void>) => {
    if (pending) return false;
    setPending(true);
    try {
      await work();
      setError(null);
      return true;
    } catch (err) {
      console.error("record failed", err);
      setError(SAVE_FAILED);
      return false;
    } finally {
      setPending(false);
    }
  };
  return { error, setError, pending, run };
}

// 新たに開いた葉: 主役は +1 / +2 の大きなボタン（UX-1）。「増えていない（+0）」は控えめなリンク（記録は leaves_new=0 で 1-6 と同じ）。
// それ以上は数字入力
function LeavesNewForm({ stemId, userId }: { stemId: string; userId: string }) {
  const { error, setError, pending, run } = useRecord();
  const [input, setInput] = useState("");

  const record = async (raw: string) => {
    const parsed = parseLeavesNew(raw);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const ok = await run(() => enqueueObservation({ stemId, type: "leaves_new", value: parsed.value, userId }).then(() => undefined));
    if (ok) setInput("");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>新たに開いた葉</CardTitle>
        <CardDescription>前回の記録から新しく開いた枚数</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          aria-label="新たに開いた葉"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void record(input);
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            {[1, 2].map((n) => (
              <RecordButton key={n} type="button" disabled={pending} data-testid={`leaves-new-${n}`} onClick={() => void record(String(n))}>
                +{n}
              </RecordButton>
            ))}
          </div>
          <div className="flex justify-center">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="text-muted-foreground"
              disabled={pending}
              data-testid="leaves-new-0"
              onClick={() => void record("0")}
            >
              増えていない（+0）
            </Button>
          </div>
          <div className="flex items-end gap-3">
            <NumberField
              id="leaves-new-input"
              label="3 枚以上のとき"
              unit="枚"
              className="flex-1"
              min={0}
              step={1}
              name="countInput"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              data-testid="leaves-new-input"
            />
            <Button type="submit" variant="outline" disabled={pending} data-testid="leaves-new-submit">
              {pending ? "記録中…" : "記録"}
            </Button>
          </div>
          <ErrorText id="leaves-new-error" error={error} />
        </form>
      </CardContent>
    </Card>
  );
}

// 枯葉処理（イベント）: 枚数を入れて確定。イベント系なので確認ダイアログを出す
function LeavesRemovedForm({ stemId, userId }: { stemId: string; userId: string }) {
  const { error, setError, pending, run } = useRecord();
  const [input, setInput] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>枯葉処理</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          aria-label="枯葉処理"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const count = input.trim();
            const message = count === "" ? "枯葉処理を記録します。よろしいですか？" : `枯葉処理 ${count} 枚を記録します。よろしいですか？`;
            if (!window.confirm(message)) return;
            const parsed = parseLeavesRemoved(count);
            if (!parsed.ok) {
              setError(parsed.error);
              return;
            }
            void run(() => enqueueLeavesRemoved({ stemId, count: parsed.value, userId }).then(() => undefined)).then((ok) => {
              if (ok) setInput("");
            });
          }}
        >
          <div className="flex items-end gap-3">
            <NumberField
              id="leaves-removed-input"
              label="除去した枚数"
              unit="枚"
              className="flex-1"
              min={1}
              step={1}
              name="count"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              data-testid="leaves-removed-input"
            />
            <Button type="submit" variant="outline" disabled={pending} data-testid="leaves-removed-submit">
              {pending ? "記録中…" : "記録"}
            </Button>
          </div>
          <ErrorText id="leaves-removed-error" error={error} />
        </form>
      </CardContent>
    </Card>
  );
}

// 現在の葉数（検算用）
function LeavesCurrentForm({ stemId, userId }: { stemId: string; userId: string }) {
  const { error, setError, pending, run } = useRecord();
  const [input, setInput] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>現在の葉数</CardTitle>
        <CardDescription>検算用。累計とのずれがあれば警告を出します</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          aria-label="現在の葉数"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = parseLeavesCurrent(input);
            if (!parsed.ok) {
              setError(parsed.error);
              return;
            }
            void run(() => enqueueObservation({ stemId, type: "leaves_current", value: parsed.value, userId }).then(() => undefined)).then((ok) => {
              if (ok) setInput("");
            });
          }}
        >
          <div className="flex items-end gap-3">
            <NumberField
              id="leaves-current-input"
              label="今ついている葉の枚数"
              unit="枚"
              className="flex-1"
              min={0}
              step={1}
              name="count"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              data-testid="leaves-current-input"
            />
            <Button type="submit" variant="outline" disabled={pending} data-testid="leaves-current-submit">
              {pending ? "記録中…" : "記録"}
            </Button>
          </div>
          <ErrorText id="leaves-current-error" error={error} />
        </form>
      </CardContent>
    </Card>
  );
}
