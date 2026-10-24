// 端末（localStorage）に残す利便のための情報（UX-1）。事実の記録ではないのでサーバーには保存しない。
// - 最近開いた株（recent-mats.ts）
// - 直近に開いた圃場（下部タブ「地図」の行き先）
// どちらもログインしたユーザーのもの。別のユーザー（別の組織）でログインし直したときに前の人の株・圃場が残ると、
// RLS で見えない画面（404）に案内してしまうので、持ち主（ユーザー id）を一緒に残し、違えば消す。ログアウトでも消す。
// ここは純粋な関数だけ（UI・localStorage に依存しない）。読み書きは src/components/app/device-store.tsx が行う。
import { RECENT_MATS_KEY } from "./recent-mats";

export const DEVICE_OWNER_KEY = "device-owner";
export const LAST_FIELD_KEY = "last-field";

// 持ち主が変わったら消すキー（持ち主のキー自体は含めない）
export const USER_SCOPED_KEYS: readonly string[] = [RECENT_MATS_KEY, LAST_FIELD_KEY];

// 保存されている持ち主と、いまのユーザーが違えば（未記録も含めて）消す
export function shouldClearForUser(storedOwner: string | null, userId: string): boolean {
  return storedOwner !== userId;
}

export type LastField = { id: string; name: string };

export function parseLastField(raw: string | null | undefined): LastField | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const r = v as Record<string, unknown>;
    if (typeof r.id !== "string" || r.id === "") return null;
    return { id: r.id, name: typeof r.name === "string" ? r.name : "" };
  } catch {
    return null;
  }
}

// 下部タブ「地図」の行き先: 直近に開いた圃場の地図。未記録なら地図用の圃場選択（/map）
export function mapTabHref(last: LastField | null): string {
  return last ? `/fields/${last.id}/map` : "/map";
}
