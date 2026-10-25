// 株の位置の修正（2-3）。地図の「位置を直す」モードで動かした株だけを抜き出し、Server Action の入力を検証する。
// UI・DB に依存しない純粋関数。位置の更新は株の属性の修正なので events は作らない（RPC relocate_mats、0013）。
import { distanceM, type LatLng } from "../geo";

// これより小さい移動は「動かしていない」とみなす（タップのぶれ・浮動小数点の誤差を拾わない）
export const MIN_RELOCATE_DISTANCE_M = 0.05;

// 一度に直せる株の数の上限（1 回の RPC に渡す配列の大きさを抑える）
export const MAX_RELOCATE_MATS = 500;

export type MatPosition = LatLng & { id: string };
export type MatMove = { matId: string; lat: number; lng: number };

// 元の位置（original）と今の位置（current: 株の id → 位置）を比べ、動かした株だけを返す。
// current に無い株・元の一覧に無い id は無視する。順は original の順
export function extractMoves(
  original: readonly MatPosition[],
  current: ReadonlyMap<string, LatLng>,
  minDistanceM = MIN_RELOCATE_DISTANCE_M,
): MatMove[] {
  const moves: MatMove[] = [];
  for (const m of original) {
    const p = current.get(m.id);
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (distanceM(m, p) < minDistanceM) continue;
    moves.push({ matId: m.id, lat: p.lat, lng: p.lng });
  }
  return moves;
}

export type RelocateInput = { fieldId: string; moves: MatMove[] };
export type RelocateValidation = { ok: true; value: RelocateInput } | { ok: false; error: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateRelocateInput(input: RelocateInput): RelocateValidation {
  if (!UUID_PATTERN.test(input?.fieldId ?? "")) return { ok: false, error: "圃場が見つかりません" };
  const moves = Array.isArray(input.moves) ? input.moves : [];
  if (moves.length === 0) return { ok: false, error: "動かした株がありません" };
  if (moves.length > MAX_RELOCATE_MATS) {
    return { ok: false, error: `一度に直せるのは ${MAX_RELOCATE_MATS} 株までです` };
  }
  const seen = new Set<string>();
  for (const m of moves) {
    if (!UUID_PATTERN.test(m?.matId ?? "")) return { ok: false, error: "画面を再読み込みしてやり直してください" };
    if (seen.has(m.matId)) return { ok: false, error: "同じ株が 2 回含まれています。画面を再読み込みしてやり直してください" };
    seen.add(m.matId);
    if (
      typeof m.lat !== "number" ||
      typeof m.lng !== "number" ||
      !Number.isFinite(m.lat) ||
      !Number.isFinite(m.lng) ||
      Math.abs(m.lat) > 90 ||
      Math.abs(m.lng) > 180
    ) {
      return { ok: false, error: "位置が正しくありません。画面を再読み込みしてやり直してください" };
    }
  }
  return { ok: true, value: { fieldId: input.fieldId, moves: moves.map((m) => ({ matId: m.matId, lat: m.lat, lng: m.lng })) } };
}

// 地図に出す株の位置: サーバーの値に、確定済みでまだ再描画が届いていない位置（overrides）を重ねる
export function applyPositionOverrides<T extends MatPosition>(mats: readonly T[], overrides: ReadonlyMap<string, LatLng>): T[] {
  if (overrides.size === 0) return [...mats];
  return mats.map((m) => {
    const p = overrides.get(m.id);
    return p ? { ...m, lat: p.lat, lng: p.lng } : m;
  });
}
