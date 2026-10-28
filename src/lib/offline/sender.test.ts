import { describe, expect, it } from "vitest";
import type { AppDb } from "../db";
import type { createClient } from "../supabase/client";
import { newLeavesRemovedItem, newStemEventItem } from "./items";
import { createSender } from "./sender";

// 3-3: 出蕾・茎の被害を送れたら、その茎の収穫予測日を再計算させる（それ以外のイベントでは呼ばない。送信に失敗したら呼ばない）
type Rpc = { name: string; args: Record<string, unknown> };

function fakeSupabase(options: { rpcError?: { message: string; code?: string } } = {}) {
  const rpcs: Rpc[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return { error: options.rpcError ?? null, status: options.rpcError ? 400 : 200 };
    },
    from: () => ({ upsert: async () => ({ error: null, status: 201 }) }),
  };
  return { client: client as unknown as ReturnType<typeof createClient>, rpcs };
}

const stemEvent = (type: "bud_emerged" | "damage" | "bagged") =>
  newStemEventItem({
    id: `e-${type}`,
    createdAt: new Date("2026-10-20T00:00:00Z"),
    stemId: "stem-1",
    type,
    occurredAt: "2026-10-20T00:00:00.000Z",
    payload: {},
  });

describe("createSender の収穫予測の再計算（3-3）", () => {
  it("出蕾・被害を RPC で送れたら、その茎の再計算を呼ぶ（送った後に）", async () => {
    const { client, rpcs } = fakeSupabase();
    const calls: { stemId: string; rpcsBefore: number }[] = [];
    const send = createSender({} as AppDb, client, async (stemId) => void calls.push({ stemId, rpcsBefore: rpcs.length }));
    await send(stemEvent("bud_emerged"), async () => {});
    await send(stemEvent("damage"), async () => {});
    expect(calls).toEqual([
      { stemId: "stem-1", rpcsBefore: 1 },
      { stemId: "stem-1", rpcsBefore: 2 },
    ]);
  });

  it("袋掛け・枯葉処理などでは呼ばない", async () => {
    const { client } = fakeSupabase();
    const calls: string[] = [];
    const send = createSender({} as AppDb, client, async (stemId) => void calls.push(stemId));
    await send(stemEvent("bagged"), async () => {});
    await send(
      newLeavesRemovedItem({ id: "l1", createdAt: new Date(), stemId: "stem-1", count: 2, occurredAt: new Date(), userId: "u" }),
      async () => {},
    );
    expect(calls).toEqual([]);
  });

  it("RPC が失敗したら呼ばない（送信の失敗として投げる）", async () => {
    const { client } = fakeSupabase({ rpcError: { message: "出蕾は栽培中の茎にだけ記録できます", code: "P0001" } });
    const calls: string[] = [];
    const send = createSender({} as AppDb, client, async (stemId) => void calls.push(stemId));
    await expect(send(stemEvent("bud_emerged"), async () => {})).rejects.toBeTruthy();
    expect(calls).toEqual([]);
  });
});
