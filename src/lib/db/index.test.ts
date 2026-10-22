import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { newObservationItem } from "../offline/items";
import { runOutbox } from "../offline/worker";
import { AppDb, outboxStore } from "./index";

// Dexie のストアと outboxStore（worker に渡す読み書き）を fake-indexeddb で確かめる
let db: AppDb;
let seq = 0;

beforeEach(async () => {
  seq += 1;
  db = new AppDb(`test-${seq}`);
  await db.open();
});

const obs = (id: string, createdAt: string) =>
  newObservationItem({ id, createdAt: new Date(createdAt), stemId: "stem-1", type: "leaves_new", value: 1, observedAt: new Date(createdAt), userId: "u" });

describe("outbox ストア", () => {
  it("list は created_at 順。remove で消え、put で更新される", async () => {
    await db.outbox.bulkAdd([obs("b", "2026-10-23T00:00:02Z"), obs("a", "2026-10-23T00:00:01Z")]);
    const store = outboxStore(db);
    expect((await store.list()).map((i) => i.id)).toEqual(["a", "b"]);
    await store.put({ ...obs("a", "2026-10-23T00:00:01Z"), attempts: 3, last_error: "x", needs_attention: 1 });
    expect(await db.outbox.get("a")).toMatchObject({ attempts: 3, last_error: "x", needs_attention: 1 });
    expect(await db.outbox.where("needs_attention").equals(1).count()).toBe(1);
    await store.remove("a");
    expect((await store.list()).map((i) => i.id)).toEqual(["b"]);
  });

  it("同じ id を 2 回 add すると失敗する（outbox 内で二重にならない）", async () => {
    await db.outbox.add(obs("a", "2026-10-23T00:00:01Z"));
    await expect(db.outbox.add(obs("a", "2026-10-23T00:00:01Z"))).rejects.toThrow();
    expect(await db.outbox.count()).toBe(1);
  });

  it("worker と組み合わせて、送れた項目が outbox から消える", async () => {
    await db.outbox.bulkAdd([obs("a", "2026-10-23T00:00:01Z"), obs("b", "2026-10-23T00:00:02Z")]);
    const sent: string[] = [];
    const r = await runOutbox(outboxStore(db), async (item) => {
      sent.push(item.id);
    });
    expect(sent).toEqual(["a", "b"]);
    expect(r.sent).toBe(2);
    expect(await db.outbox.count()).toBe(0);
  });

  it("pendingPhotos に Blob を保存し、取り出せる", async () => {
    const blob = new Blob(["jpeg-bytes"], { type: "image/jpeg" });
    await db.pendingPhotos.put({ id: "p1", blob, content_type: "image/jpeg" });
    const got = await db.pendingPhotos.get("p1");
    expect(got?.content_type).toBe("image/jpeg");
    expect(await got!.blob.text()).toBe("jpeg-bytes");
    await db.pendingPhotos.delete("p1");
    expect(await db.pendingPhotos.count()).toBe(0);
  });
});
