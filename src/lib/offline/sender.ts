"use client";

// outbox の 1 項目をサーバーに送る（ブラウザの supabase-js クライアント。RLS で保護）。
//
// - observations / events / photos の行は upsert(ignoreDuplicates) = ON CONFLICT DO NOTHING 相当。再送しても二重にならない
// - 茎のイベントは RPC record_stem_event（0009: p_id で冪等）
// - 写真はまず Storage（同じパスに upsert）→ 成功したら progress で uploaded=true を保存し Blob を消す → photos に upsert。
//   Storage の後に DB が失敗しても、再送は DB だけやり直す
// - organization_id は渡さない（INSERT トリガーが親からコピーする）
// - 失敗は SendError（message / code / status）に正規化して throw する（retry.ts が再試行か要確認かを判定）
import type { AppDb } from "../db";
import { createClient } from "../supabase/client";
import { toSendError } from "./retry";
import type { OutboxItem, SendError } from "./types";
import type { Sender } from "./worker";

type SupabaseBrowser = ReturnType<typeof createClient>;

function fail(error: { message: string; code?: string | null; name?: string }, status?: number | null): never {
  throw toSendError(error, status) satisfies SendError;
}

// 3-3: 出蕾・被害を送れたら、その茎の収穫予測日を再計算させる（/api/predictions/recompute）。
// 3-4: 同じ呼び出しで提案も評価する。袋掛け・摘蕾・収穫を送れたら対応する提案が done、喪失（被害）なら dismissed になる。
// 失敗してもイベントの送信は成功のまま（推定は日次の再計算・茎の画面を開いたときに追いつく）。待ってから戻るので、
// 同期の後の router.refresh() では新しい推定が読める
// 3-5: 収穫（収穫後の追肥は株が対象。再計算は茎の株も評価する）に加え、枯葉処理（events への直接の追記）と、
// 葉数の観測（新葉・現在の葉数。検算の「確認」）も送れたら再計算させる
export const RECOMPUTE_EVENT_TYPES: readonly string[] = ["bud_emerged", "damage", "bagged", "debudded", "harvested", "leaves_removed"];
export const RECOMPUTE_OBSERVATION_TYPES: readonly string[] = ["leaves_new", "leaves_current"];

export type RecomputeStem = (stemId: string) => Promise<void>;

export const recomputeStemOverHttp: RecomputeStem = async (stemId) => {
  try {
    const res = await fetch("/api/predictions/recompute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stemId }),
    });
    if (!res.ok) console.error("harvest recompute failed", res.status);
  } catch (e) {
    console.error("harvest recompute failed", e);
  }
};

export function createSender(
  db: AppDb,
  supabase: SupabaseBrowser = createClient(),
  recomputeStem: RecomputeStem = recomputeStemOverHttp,
): Sender {
  return async (item, progress) => {
    switch (item.kind) {
      case "observation": {
        const p = item.payload;
        const { error, status } = await supabase
          .from("observations")
          .upsert(
            { id: p.id, stem_id: p.stem_id, type: p.type, value: p.value, observed_at: p.observed_at, observed_by: p.observed_by },
            { onConflict: "id", ignoreDuplicates: true },
          );
        if (error) fail(error, status);
        if (RECOMPUTE_OBSERVATION_TYPES.includes(p.type)) await recomputeStem(p.stem_id);
        return;
      }
      case "event": {
        const p = item.payload;
        if (p.method === "insert") {
          const { error, status } = await supabase
            .from("events")
            .upsert(
              {
                id: p.id,
                type: p.type,
                target_type: p.target_type,
                target_id: p.target_id,
                occurred_at: p.occurred_at,
                recorded_by: p.recorded_by,
                payload: p.payload,
              },
              { onConflict: "id", ignoreDuplicates: true },
            );
          if (error) fail(error, status);
          if (RECOMPUTE_EVENT_TYPES.includes(p.type)) await recomputeStem(p.target_id);
          return;
        }
        if (p.method === "record_sucker_emerged") {
          // 2-1: 吸芽の茎とイベントを 1 トランザクションで（0010: p_event_id で冪等）
          const { error, status } = await supabase.rpc("record_sucker_emerged", {
            p_event_id: p.id,
            p_sucker_stem_id: p.sucker_stem_id,
            p_parent_stem_id: p.parent_stem_id,
            p_occurred_at: p.occurred_at,
            p_payload: p.payload,
            p_note: p.note,
          });
          if (error) fail(error, status);
          return;
        }
        if (p.method === "adopt_sucker") {
          // 2-2: 吸芽の採用（0011: p_event_id で冪等。栽培中 3 本の違反は日本語の例外 → 要確認）
          const { error, status } = await supabase.rpc("adopt_sucker", {
            p_event_id: p.id,
            p_stem_id: p.stem_id,
            p_occurred_at: p.occurred_at,
            p_initial_leaf_count: p.payload.initial_leaf_count,
          });
          if (error) fail(error, status);
          return;
        }
        if (p.method === "remove_sucker") {
          // 2-2: 吸芽の芽かき（0011: p_event_id で冪等）
          const { error, status } = await supabase.rpc("remove_sucker", {
            p_event_id: p.id,
            p_stem_id: p.stem_id,
            p_occurred_at: p.occurred_at,
            p_note: p.note,
          });
          if (error) fail(error, status);
          return;
        }
        const { error, status } = await supabase.rpc("record_stem_event", {
          p_id: p.id,
          p_stem_id: p.stem_id,
          p_type: p.type,
          p_occurred_at: p.occurred_at,
          p_payload: p.payload,
          p_note: p.note,
        });
        if (error) fail(error, status);
        if (RECOMPUTE_EVENT_TYPES.includes(p.type)) await recomputeStem(p.stem_id);
        return;
      }
      case "photo":
        await sendPhoto(db, supabase, item, progress);
        return;
    }
  };
}

async function sendPhoto(
  db: AppDb,
  supabase: SupabaseBrowser,
  item: Extract<OutboxItem, { kind: "photo" }>,
  progress: (item: OutboxItem) => Promise<void>,
) {
  let current = item;
  if (!current.payload.uploaded) {
    const pending = await db.pendingPhotos.get(current.id);
    if (!pending) {
      // Blob が端末にない（容量不足で消えた等）。再送しても直らないので要確認にする
      fail({ message: "写真のデータが端末に残っていません。撮り直してください", code: "LOCAL_BLOB_MISSING" }, 400);
    }
    const { error } = await supabase.storage
      .from("photos")
      .upload(current.payload.storage_path, pending.blob, { contentType: pending.content_type, upsert: true });
    if (error) fail(error);
    current = { ...current, payload: { ...current.payload, uploaded: true } };
    await progress(current);
    await db.pendingPhotos.delete(current.id);
  }
  const p = current.payload;
  const { error, status } = await supabase.from("photos").upsert(
    {
      id: p.id,
      storage_path: p.storage_path,
      taken_at: p.taken_at,
      taken_by: p.taken_by,
      lat: p.lat,
      lng: p.lng,
      target_type: p.target_type,
      target_id: p.target_id,
      kind: p.kind,
      upload_status: "uploaded",
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (error) fail(error, status);
}
