// 端末のキャッシュ（2-9）から、画面に渡すデータを組み立てる純粋関数（offline-sync.md 5.4・5.5）。
// サーバー（RSC）の画面が Supabase から組み立てるものと同じ形にして、既存の画面の部品で描けるようにする。
// - 集計（weekly_stems、0016）はキャッシュしない。茎・観測の行から同じ条件で計算し直す
// - 記録者の名前（profiles）はキャッシュしないので null（履歴に名前を出さない）
// - 写真は画像本体を持たないので url=null・offline=true（「写真（オフラインでは表示できません）」）
import { FIELD_HISTORY_LIMIT, type FieldDetailData } from "../fields/detail";
import { MAT_HISTORY_LIMIT, type MatDetailData } from "../mats/detail";
import { representativeStemStatus } from "../nearby";
import type { MatStemRow } from "../offline/overlay";
import type { EventRow, ObservationRow, PhotoRow } from "../stems/records";
import { sortStemsByGeneration } from "../stems/status";
import type { StemViewInput } from "../stems/view";
import type { WeeklyStemRow } from "../weekly";
import type { CacheOwner, CacheSnapshot, CachedEvent, SyncMeta } from "./types";

const byOccurredDesc = (a: CachedEvent, b: CachedEvent) =>
  b.occurred_at.localeCompare(a.occurred_at) || b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id);

function toEventRow(e: CachedEvent): EventRow {
  return {
    id: e.id,
    type: e.type,
    occurred_at: e.occurred_at,
    payload: e.payload ?? null,
    superseded_by: e.superseded_by,
    note: e.note,
    recorder_name: null,
  };
}

// 対象（圃場・株・茎）のイベント（新しい順）
function targetEvents(snapshot: CacheSnapshot, targetType: string, targetId: string): CachedEvent[] {
  return snapshot.events.filter((e) => e.target_type === targetType && e.target_id === targetId).sort(byOccurredDesc);
}

// ホームの圃場の一覧（名前順）
export function homeFields(snapshot: CacheSnapshot): { id: string; name: string; code: string }[] {
  return [...snapshot.fields]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => ({ id: f.id, name: f.name, code: f.code }));
}

// view weekly_stems（0016）と同じ行: 撤去していない株の栽培中・出蕾済みの茎ごとに、最後の leaves_new の日時と合計（訂正済みを除く）
export function weeklyRowsFromCache(snapshot: CacheSnapshot): WeeklyStemRow[] {
  const fields = new Map(snapshot.fields.map((f) => [f.id, f]));
  const mats = new Map(snapshot.mats.map((m) => [m.id, m]));
  const leaves = new Map<string, { last: string | null; sum: number }>();
  for (const o of snapshot.observations) {
    if (o.type !== "leaves_new" || o.superseded_by !== null) continue;
    const cur = leaves.get(o.stem_id) ?? { last: null, sum: 0 };
    cur.sum += Number(o.value);
    if (cur.last === null || Date.parse(o.observed_at) > Date.parse(cur.last)) cur.last = o.observed_at;
    leaves.set(o.stem_id, cur);
  }
  const rows: WeeklyStemRow[] = [];
  for (const s of snapshot.stems) {
    if (s.status !== "active" && s.status !== "flowered") continue;
    const m = mats.get(s.mat_id);
    if (!m || m.status !== "active") continue;
    const f = fields.get(m.field_id);
    if (!f) continue;
    const l = leaves.get(s.id);
    rows.push({
      stem_id: s.id,
      mat_id: m.id,
      mat_code: m.code,
      mat_status: m.status,
      field_id: f.id,
      field_name: f.name,
      generation: s.generation,
      status: s.status,
      started_at: s.started_at,
      bud_emerged_at: s.bud_emerged_at,
      initial_leaf_count: s.initial_leaf_count ?? 0,
      last_leaves_new_at: l?.last ?? null,
      leaves_new_sum: l?.sum ?? 0,
    });
  }
  return rows;
}

export function fieldDetailFromCache(snapshot: CacheSnapshot, fieldId: string): FieldDetailData | null {
  const f = snapshot.fields.find((x) => x.id === fieldId);
  if (!f) return null;
  return {
    field: { id: f.id, name: f.name, code: f.code, center_lat: f.center_lat, center_lng: f.center_lng, notes: f.notes },
    history: targetEvents(snapshot, "field", fieldId).slice(0, FIELD_HISTORY_LIMIT).map(toEventRow),
    historyError: null,
  };
}

export type MapMatItem = { id: string; code: string; lat: number; lng: number; stemStatus: string | null };

// 地図（オフライン）: 圃場と、撤去していない株（株コード順）と代表の茎の状態
export function fieldMapFromCache(
  snapshot: CacheSnapshot,
  fieldId: string,
): { field: { id: string; name: string; code: string }; mats: MapMatItem[] } | null {
  const f = snapshot.fields.find((x) => x.id === fieldId);
  if (!f) return null;
  const mats = snapshot.mats
    .filter((m) => m.field_id === fieldId && m.status === "active")
    .sort((a, b) => a.code.localeCompare(b.code, "ja", { numeric: true }))
    .map((m) => ({
      id: m.id,
      code: m.code,
      lat: m.lat,
      lng: m.lng,
      stemStatus: representativeStemStatus(snapshot.stems.filter((s) => s.mat_id === m.id)),
    }));
  return { field: { id: f.id, name: f.name, code: f.code }, mats };
}

export function matDetailFromCache(
  snapshot: CacheSnapshot,
  matId: string,
  cultivars: SyncMeta["cultivars"],
): MatDetailData | null {
  const mat = snapshot.mats.find((m) => m.id === matId);
  if (!mat) return null;
  const field = snapshot.fields.find((f) => f.id === mat.field_id) ?? null;
  const cultivar = cultivars.find((c) => c.id === mat.cultivar_id) ?? null;
  let origin: MatDetailData["origin"] = null;
  if (mat.origin_stem_id) {
    const originStem = snapshot.stems.find((s) => s.id === mat.origin_stem_id);
    const originMat = originStem ? snapshot.mats.find((m) => m.id === originStem.mat_id) : undefined;
    if (originStem && originMat) origin = { matId: originMat.id, matCode: originMat.code, generation: originStem.generation };
  }
  const stems: MatStemRow[] = sortStemsByGeneration(snapshot.stems.filter((s) => s.mat_id === matId)).map((s) => ({
    id: s.id,
    generation: s.generation,
    status: s.status,
    started_at: s.started_at,
    initial_leaf_count: s.initial_leaf_count ?? 0,
    parent_stem_id: s.parent_stem_id,
    observations: snapshot.observations
      .filter((o) => o.stem_id === s.id && o.superseded_by === null)
      .map((o) => ({ id: o.id, type: o.type, value: Number(o.value), observed_at: o.observed_at })),
  }));
  const matEvents = targetEvents(snapshot, "mat", matId);
  const removed = matEvents.find((e) => e.type === "mat_removed" && e.superseded_by === null) ?? null;
  return {
    mat: { id: mat.id, code: mat.code, planted_at: mat.planted_at, origin_type: mat.origin_type, status: mat.status },
    field: field ? { id: field.id, name: field.name, code: field.code } : null,
    cultivarName: cultivar?.name ?? null,
    origin,
    stems,
    stemsError: null,
    removedEvent: removed ? { occurred_at: removed.occurred_at, payload: removed.payload } : null,
    history: matEvents.slice(0, MAT_HISTORY_LIMIT).map(toEventRow),
    historyError: null,
  };
}

// 茎の画面（記録入力・履歴）の入力。茎か株がキャッシュに無ければ null
export function stemFromCache(snapshot: CacheSnapshot, stemId: string, owner: CacheOwner): StemViewInput | null {
  const stem = snapshot.stems.find((s) => s.id === stemId);
  if (!stem) return null;
  const mat = snapshot.mats.find((m) => m.id === stem.mat_id);
  if (!mat) return null;
  const observations: ObservationRow[] = snapshot.observations
    .filter((o) => o.stem_id === stemId)
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at))
    .map((o) => ({
      id: o.id,
      type: o.type,
      value: Number(o.value),
      observed_at: o.observed_at,
      superseded_by: o.superseded_by,
      observer_name: null,
    }));
  const events: EventRow[] = targetEvents(snapshot, "stem", stemId).map((e) => {
    const row = toEventRow(e);
    delete row.note; // 茎の画面（RSC）は note を引いていない。表示を揃える
    return row;
  });
  const photos: PhotoRow[] = snapshot.photos
    .filter((p) => p.target_type === "stem" && p.target_id === stemId)
    .sort((a, b) => b.taken_at.localeCompare(a.taken_at))
    .map((p) => ({ id: p.id, kind: p.kind, taken_at: p.taken_at, url: null, taker_name: null, offline: true }));
  return {
    id: stem.id,
    generation: stem.generation,
    status: stem.status,
    initialLeafCount: stem.initial_leaf_count ?? 0,
    mat: { id: mat.id, code: mat.code },
    userId: owner.user_id,
    organizationId: stem.organization_id,
    observations,
    events,
    photos,
  };
}
