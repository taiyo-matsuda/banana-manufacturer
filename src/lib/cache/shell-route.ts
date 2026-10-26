// オフラインの殻（2-9、offline-sync.md 5.5）が描く画面の判定。純粋関数。
// public/sw.js の SHELL_ROUTES と同じ対象。片方を変えたら両方を変える。
export type ShellRoute =
  | { kind: "home" }
  | { kind: "field"; fieldId: string }
  | { kind: "map"; fieldId: string }
  | { kind: "mat"; matId: string }
  | { kind: "stem"; stemId: string }
  | { kind: "history"; stemId: string };

const ID = "([0-9A-Za-z-]+)";
const PATTERNS: [RegExp, (id: string) => ShellRoute][] = [
  [new RegExp(`^/fields/${ID}$`), (id) => ({ kind: "field", fieldId: id })],
  [new RegExp(`^/fields/${ID}/map$`), (id) => ({ kind: "map", fieldId: id })],
  [new RegExp(`^/mats/${ID}$`), (id) => ({ kind: "mat", matId: id })],
  [new RegExp(`^/stems/${ID}$`), (id) => ({ kind: "stem", stemId: id })],
  [new RegExp(`^/stems/${ID}/history$`), (id) => ({ kind: "history", stemId: id })],
];

// 殻の対象でない（/fields/new、/weekly など）なら null
export function matchShellRoute(pathname: string): ShellRoute | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/") return { kind: "home" };
  for (const [re, make] of PATTERNS) {
    const m = re.exec(path);
    if (m && m[1] !== "new") return make(m[1]);
  }
  return null;
}
