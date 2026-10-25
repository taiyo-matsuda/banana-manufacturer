"use client";

import { LocateFixedIcon, LoaderCircleIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { accuracyWarning, formatDistance, nearbyStemLabel, type NearbyResult } from "@/lib/nearby";
import { LinkList, LinkListItem, LinkRow } from "./link-list";

// 現在地から近い株（2-8、画面 2）の部品。地図の「現在地」ボタンと、地図の下に出す候補（近い順に 3 株）。
// 並べ替え・距離・精度の注意の文言は src/lib/nearby.ts（純粋関数）。

export type NearbyMat = { id: string; code: string; lat: number; lng: number; stemStatus: string | null };

// 地図の右下（MapLibre の出典の上）に重ねる「現在地」ボタン。取得中は読み込み中の表示で押せない
export function LocateButton({ locating, onClick }: { locating: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      className="shadow-md"
      onClick={onClick}
      disabled={locating}
      aria-busy={locating}
      data-testid="locate-button"
      data-locating={locating ? "true" : "false"}
    >
      {locating ? (
        <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
      ) : (
        <LocateFixedIcon aria-hidden="true" />
      )}
      {locating ? "取得中…" : "現在地"}
    </Button>
  );
}

// 近い株の候補。精度が悪いときは注意を上に出す（候補は 3 株のまま）
export function NearbyMatList({ results, accuracyM }: { results: NearbyResult<NearbyMat>[]; accuracyM: number }) {
  const warning = accuracyWarning(accuracyM);
  return (
    <section className="flex flex-col gap-3" data-testid="nearby" aria-label="近い株">
      <h2 className="font-semibold">現在地から近い株</h2>
      {warning && (
        <Alert variant="warning" data-testid="nearby-accuracy-warning">
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      )}
      {results.length === 0 ? (
        <p className="text-muted-foreground" data-testid="nearby-empty">
          この圃場には株がありません
        </p>
      ) : (
        <LinkList>
          {results.map((m, i) => (
            <LinkListItem key={m.id} data-testid="nearby-row" data-mat-code={m.code} data-distance-m={m.distanceM.toFixed(2)}>
              <LinkRow href={`/mats/${m.id}`}>
                <span className="flex min-w-0 items-center gap-3">
                  <span className="text-sm text-muted-foreground" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="truncate font-mono font-medium" data-testid="nearby-code">
                    {m.code}
                  </span>
                  <Badge variant="outline" data-testid="nearby-stem-status">
                    {nearbyStemLabel(m.stemStatus)}
                  </Badge>
                </span>
                <span className="shrink-0 tabular-nums" data-testid="nearby-distance">
                  {formatDistance(m.distanceM)}
                </span>
              </LinkRow>
            </LinkListItem>
          ))}
        </LinkList>
      )}
    </section>
  );
}
