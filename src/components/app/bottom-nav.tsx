"use client";

import Link from "next/link";
import { ChartLineIcon, HomeIcon, MapIcon, SettingsIcon } from "lucide-react";
import { cn } from "cn";
import { LAST_FIELD_KEY, mapTabHref, parseLastField } from "@/lib/device-prefs";
import { useStoredValue } from "./device-store";

// 下部タブ（UX-1、screens.md 3 章）: ホーム / 地図 / 予測 / 設定。
// - 地図: 直近に開いた圃場の地図（端末に記録）。未記録なら地図用の圃場選択 /map（圃場が 1 つならその地図へ転送）
// - 予測: /forecast（予測一覧、3-6）
// - 設定: /fields（圃場の一覧とログアウト）
// ログイン画面とオフライン画面には出さない。現在地のタブは aria-current="page" で強調（current 省略時はどれも強調しない）。
// 各タブは高さ 64px（タップ領域 44px 以上）。iPhone のホームバーの分は safe-area-inset-bottom で空ける。
export type NavTab = "home" | "map" | "forecast" | "settings";

export function BottomNav({ current }: { current?: NavTab }) {
  const lastField = useStoredValue(LAST_FIELD_KEY, parseLastField, null);
  const tabs: { key: NavTab; href: string; label: string; Icon: typeof HomeIcon }[] = [
    { key: "home", href: "/", label: "ホーム", Icon: HomeIcon },
    { key: "map", href: mapTabHref(lastField), label: "地図", Icon: MapIcon },
    { key: "forecast", href: "/forecast", label: "予測", Icon: ChartLineIcon },
    { key: "settings", href: "/fields", label: "設定", Icon: SettingsIcon },
  ];
  return (
    <nav
      aria-label="メイン"
      data-testid="bottom-nav"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-backdrop-filter:bg-background/80"
    >
      <ul className="mx-auto grid max-w-md grid-cols-4">
        {tabs.map(({ key, href, label, Icon }) => {
          const active = key === current;
          return (
            <li key={key}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                data-testid={`nav-${key}`}
                className={cn(
                  "flex h-16 flex-col items-center justify-center gap-0.5 text-xs font-medium",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <Icon className={cn("size-6", active && "stroke-[2.5]")} aria-hidden="true" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
