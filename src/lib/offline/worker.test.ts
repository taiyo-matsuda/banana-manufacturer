import { describe, expect, it } from "vitest";
import { newLeavesRemovedItem, newObservationItem, newPhotoItem } from "./items";
import { MAX_AUTO_ATTEMPTS } from "./retry";
import type { OutboxItem } from "./types";
import { type OutboxStore, runOutbox, type Sender } from "./worker";

// メモリ上の outbox（Dexie の代わり）
function memoryStore(initial: OutboxItem[] = []) {
  const map = new Map(initial.map((i) => [i.id, i]));
  const store: OutboxStore = {
    list: async () => [...map.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    remove: async (id) => void map.delete(id),
    put: async (item) => void map.set(item.id, item),
  };
  return { store, map };
}

const obs = (id: string, createdAt: string, value = 1) =>
  newObservationItem({
    id,
    createdAt: new Date(createdAt),
    stemId: "stem-1",
    type: "leaves_new",
    value,
    observedAt: new Date(createdAt),
    userId: "user-1",
  });

const networkError = () => Object.assign(new TypeError("Failed to fetch"), {});
const rpcError = () => ({ message: "出蕾は栽培中の茎にだけ記録できます", code: "P0001", status: 400 });

describe("runOutbox（同期ワーカー）", () => {
  it("created_at 順に 1 件ずつ送り、成功したら outbox から消す", async () => {
    const { store, map } = memoryStore([obs("b", "2026-10-23T00:00:02Z"), obs("a", "2026-10-23T00:00:01Z"), obs("c", "2026-10-23T00:00:03Z")]);
    const sent: string[] = [];
    const sender: Sender = async (item) => {
      sent.push(item.id);
    };
    const r = await runOutbox(store, sender, { now: () => 0 });
    expect(sent).toEqual(["a", "b", "c"]);
    expect(map.size).toBe(0);
    expect(r).toEqual({ sent: 3, failed: 0, skipped: 0, nextAttemptAt: null });
  });

  it("圏外（online=false）なら何も送らず attempts も増やさない", async () => {
    const { store, map } = memoryStore([obs("a", "2026-10-23T00:00:01Z")]);
    let called = 0;
    const r = await runOutbox(
      store,
      async () => {
        called += 1;
      },
      { online: () => false },
    );
    expect(called).toBe(0);
    expect(map.get("a")!.attempts).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it("ネットワーク失敗は attempts を増やしてバックオフし、次の項目は続けて送る。次回時刻を返す", async () => {
    const { store, map } = memoryStore([obs("a", "2026-10-23T00:00:01Z"), obs("b", "2026-10-23T00:00:02Z")]);
    const now = 5_000;
    const sender: Sender = async (item) => {
      if (item.id === "a") throw networkError();
    };
    const r = await runOutbox(store, sender, { now: () => now });
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(1);
    expect(map.has("b")).toBe(false);
    const a = map.get("a")!;
    expect(a.attempts).toBe(1);
    expect(a.needs_attention).toBe(0);
    expect(a.last_error).toBe("Failed to fetch");
    expect(a.next_attempt_at).toBe(now + 1_000);
    expect(r.nextAttemptAt).toBe(now + 1_000);

    // バックオフ中は飛ばす（送らない）
    let called = 0;
    const r2 = await runOutbox(
      store,
      async () => {
        called += 1;
      },
      { now: () => now + 500 },
    );
    expect(called).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(r2.nextAttemptAt).toBe(now + 1_000);

    // 時刻が来たら送る
    const r3 = await runOutbox(
      store,
      async () => {
        called += 1;
      },
      { now: () => now + 1_000 },
    );
    expect(called).toBe(1);
    expect(r3.sent).toBe(1);
    expect(map.size).toBe(0);
  });

  it(`${MAX_AUTO_ATTEMPTS} 回ネットワーク失敗したら要確認になり、以後は自動で送らない`, async () => {
    const { store, map } = memoryStore([obs("a", "2026-10-23T00:00:01Z")]);
    let t = 0;
    const sender: Sender = async () => {
      throw networkError();
    };
    for (let i = 0; i < MAX_AUTO_ATTEMPTS; i++) {
      t = (map.get("a")!.next_attempt_at ?? 0) + 1;
      await runOutbox(store, sender, { now: () => t });
    }
    const a = map.get("a")!;
    expect(a.attempts).toBe(MAX_AUTO_ATTEMPTS);
    expect(a.needs_attention).toBe(1);
    let called = 0;
    const r = await runOutbox(
      store,
      async () => {
        called += 1;
      },
      { now: () => t + 60 * 60_000 },
    );
    expect(called).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.nextAttemptAt).toBeNull(); // 要確認はタイマーを立てない
  });

  it("RPC の状態前提違反（P0001）は 1 回で要確認。last_error を保持し、他の項目は送る", async () => {
    const event = newLeavesRemovedItem({
      id: "e1",
      createdAt: new Date("2026-10-23T00:00:01Z"),
      stemId: "stem-1",
      count: 2,
      occurredAt: new Date("2026-10-23T00:00:01Z"),
      userId: "user-1",
    });
    const { store, map } = memoryStore([event, obs("o1", "2026-10-23T00:00:02Z")]);
    const sender: Sender = async (item) => {
      if (item.id === "e1") throw rpcError();
    };
    const r = await runOutbox(store, sender, { now: () => 0 });
    expect(r).toMatchObject({ sent: 1, failed: 1 });
    expect(map.has("o1")).toBe(false);
    expect(map.get("e1")).toMatchObject({ attempts: 1, needs_attention: 1, last_error: "[P0001] 出蕾は栽培中の茎にだけ記録できます", next_attempt_at: null });
  });

  it("送信の途中経過（写真: Storage 済み）は progress で保存され、失敗しても残る", async () => {
    const photo = newPhotoItem({
      id: "p1",
      createdAt: new Date("2026-10-23T00:00:01Z"),
      stemId: "stem-1",
      storagePath: "org/stem/stem-1/p1.jpg",
      contentType: "image/jpeg",
      takenAt: new Date("2026-10-23T00:00:00Z"),
      userId: "user-1",
      lat: null,
      lng: null,
      kind: "side",
    });
    const { store, map } = memoryStore([photo]);
    const sender: Sender = async (item, progress) => {
      if (item.kind !== "photo") throw new Error("unexpected");
      await progress({ ...item, payload: { ...item.payload, uploaded: true } });
      throw networkError();
    };
    await runOutbox(store, sender, { now: () => 0 });
    const p = map.get("p1")!;
    expect(p.kind === "photo" && p.payload.uploaded).toBe(true);
    expect(p.attempts).toBe(1);
  });

  it("送信中に圏外になったら残りは送らない（次の online で再開）", async () => {
    const { store, map } = memoryStore([obs("a", "2026-10-23T00:00:01Z"), obs("b", "2026-10-23T00:00:02Z")]);
    let online = true;
    const sender: Sender = async () => {
      online = false;
      throw networkError();
    };
    const r = await runOutbox(store, sender, { now: () => 0, online: () => online });
    expect(r.failed).toBe(1);
    expect(map.get("a")!.attempts).toBe(1);
    expect(map.get("b")!.attempts).toBe(0);
  });
});
