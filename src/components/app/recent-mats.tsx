"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { parseRecentMats, RECENT_MATS_KEY, type RecentMat } from "@/lib/recent-mats";
import { useStoredValue } from "./device-store";
import { LinkList, LinkListItem, LinkRow } from "./link-list";

// ホームの「最近開いた株」（直近 5 件、端末の localStorage）。タップで株の詳細へ（1 タップ）。
// SSR では空（localStorage は端末にしかない）。持ち主が変わると DeviceOwner が消す（device-store.tsx）。
const EMPTY: RecentMat[] = [];

export function RecentMats() {
  const mats = useStoredValue(RECENT_MATS_KEY, parseRecentMats, EMPTY);
  return (
    <Card data-testid="recent-mats">
      <CardHeader>
        <CardTitle>最近開いた株</CardTitle>
      </CardHeader>
      <CardContent>
        {mats.length === 0 ? (
          <p className="text-muted-foreground" data-testid="recent-mats-empty">
            まだありません。地図から株を開くとここに残ります
          </p>
        ) : (
          <LinkList>
            {mats.map((m) => (
              <LinkListItem key={m.id} data-testid="recent-mat-row">
                <LinkRow href={`/mats/${m.id}`}>
                  <span className="font-mono text-lg font-medium">{m.code}</span>
                  {m.fieldName && <span className="truncate text-sm text-muted-foreground">{m.fieldName}</span>}
                </LinkRow>
              </LinkListItem>
            ))}
          </LinkList>
        )}
      </CardContent>
    </Card>
  );
}
