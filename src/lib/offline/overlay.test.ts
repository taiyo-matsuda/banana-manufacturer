import { describe, expect, it } from "vitest";
import { cumulativeLeaves } from "../leaves";
import { buildHistory, canRecordLeaves, toLeafObservations, type EventRow, type ObservationRow, type PhotoRow } from "../stems/records";
import { canRecordEvent } from "../stemEvents";
import { newLeavesRemovedItem, newObservationItem, newPhotoItem, newStemEventItem } from "./items";
import { applyOutbox, itemsForStem } from "./overlay";

const serverObs: ObservationRow[] = [
  { id: "o-server", type: "leaves_new", value: 2, observed_at: "2026-10-01T00:00:00Z", superseded_by: null, observer_name: "太郎" },
];
const serverEvents: EventRow[] = [];
const serverPhotos: PhotoRow[] = [];
const server = { status: "active", observations: serverObs, events: serverEvents, photos: serverPhotos };

const pendingObs = (id: string, createdAt: string, stemId = "stem-1", value = 1) =>
  newObservationItem({ id, createdAt: new Date(createdAt), stemId, type: "leaves_new", value, observedAt: new Date(createdAt), userId: "u" });

describe("applyOutbox（サーバーの行 + 未送信分の重ね合わせ）", () => {
  it("未送信の観測が pending=true で重なり、累計葉数に加算される", () => {
    const r = applyOutbox(server, [pendingObs("o-1", "2026-10-23T00:00:00Z")], "stem-1");
    expect(r.observations).toHaveLength(2);
    expect(r.observations[1]).toMatchObject({ id: "o-1", type: "leaves_new", value: 1, pending: true, superseded_by: null });
    expect(r.observations[0].pending).toBeUndefined();
    expect(r.pendingCount).toBe(1);
    // 初期 4 + サーバー 2 + 未送信 1 = 7
    expect(cumulativeLeaves(4, toLeafObservations(r.observations))).toBe(7);
    // 履歴に「未同期」の印
    const h = buildHistory(r.observations, r.events, r.photos);
    expect(h.map((e) => [e.key, e.pending])).toEqual([
      ["observation:o-1", true],
      ["observation:o-server", false],
    ]);
  });

  it("同じ id がサーバーにもあれば（同期済み）二重に重ねない", () => {
    const r = applyOutbox(server, [pendingObs("o-server", "2026-10-23T00:00:00Z")], "stem-1");
    expect(r.observations).toHaveLength(1);
    expect(r.observations[0].pending).toBeUndefined();
    expect(r.pendingCount).toBe(0);
  });

  it("他の茎の未送信分は重ねない。created_at 順に並ぶ", () => {
    const items = [pendingObs("o-2", "2026-10-23T00:00:02Z"), pendingObs("x", "2026-10-23T00:00:00Z", "stem-2"), pendingObs("o-1", "2026-10-23T00:00:01Z")];
    expect(itemsForStem(items, "stem-1").map((i) => i.id)).toEqual(["o-1", "o-2"]);
    const r = applyOutbox(server, items, "stem-1");
    expect(r.observations.map((o) => o.id)).toEqual(["o-server", "o-1", "o-2"]);
  });

  it("未送信の枯葉処理（events への直接追記）がイベントとして重なる", () => {
    const item = newLeavesRemovedItem({ id: "e-1", createdAt: new Date("2026-10-23T00:00:00Z"), stemId: "stem-1", count: 2, occurredAt: new Date("2026-10-23T00:00:00Z"), userId: "u" });
    const r = applyOutbox(server, [item], "stem-1");
    expect(r.events).toEqual([
      { id: "e-1", type: "leaves_removed", occurred_at: "2026-10-23T00:00:00.000Z", payload: { count: 2 }, superseded_by: null, recorder_name: null, pending: true },
    ]);
    expect(r.status).toBe("active"); // 枯葉処理は状態を変えない
  });

  it("未送信の茎イベントで見かけの状態が変わる（出蕾 → flowered → 収穫 → harvested）。記録ボタンの可否もそれに従う", () => {
    const bud = newStemEventItem({
      id: "e-bud",
      createdAt: new Date("2026-10-23T00:00:00Z"),
      stemId: "stem-1",
      type: "bud_emerged",
      occurredAt: "2026-10-23T00:00:00.000Z",
      payload: { cumulative_leaves: 7, leaves_current: 10, girth_cm: 45.5, earliest_at: null },
    });
    const r1 = applyOutbox(server, [bud], "stem-1");
    expect(r1.status).toBe("flowered");
    expect(r1.events[0]).toMatchObject({ id: "e-bud", type: "bud_emerged", pending: true, payload: { cumulative_leaves: 7 } });
    expect(canRecordEvent(r1.status, "bud_emerged")).toBe(false);
    expect(canRecordEvent(r1.status, "bagged")).toBe(true);
    expect(canRecordLeaves(r1.status)).toBe(true);

    const harvested = newStemEventItem({
      id: "e-harvest",
      createdAt: new Date("2026-10-23T00:00:01Z"),
      stemId: "stem-1",
      type: "harvested",
      occurredAt: "2026-10-23T00:00:01.000Z",
      payload: { weight_kg: 12.5 },
    });
    const r2 = applyOutbox(server, [harvested, bud], "stem-1"); // 順序は created_at で決まる
    expect(r2.status).toBe("harvested");
    expect(canRecordLeaves(r2.status)).toBe(false);
  });

  it("被害 lost は見かけの状態を lost にし、それ以外の被害は変えない。記録できない組み合わせは状態を変えない", () => {
    const light = newStemEventItem({ id: "d1", createdAt: new Date("2026-10-23T00:00:00Z"), stemId: "stem-1", type: "damage", occurredAt: "2026-10-23T00:00:00.000Z", payload: { kind: "cold", severity: "light" } });
    expect(applyOutbox(server, [light], "stem-1").status).toBe("active");
    const lost = newStemEventItem({ id: "d2", createdAt: new Date("2026-10-23T00:00:00Z"), stemId: "stem-1", type: "damage", occurredAt: "2026-10-23T00:00:00.000Z", payload: { kind: "lodging", severity: "lost" } });
    expect(applyOutbox(server, [lost], "stem-1").status).toBe("lost");
    // 収穫済みの茎に出蕾（画面では出せない組み合わせ）は状態を変えない
    const bud = newStemEventItem({ id: "b", createdAt: new Date("2026-10-23T00:00:00Z"), stemId: "stem-1", type: "bud_emerged", occurredAt: "2026-10-23T00:00:00.000Z", payload: {} });
    expect(applyOutbox({ ...server, status: "harvested" }, [bud], "stem-1").status).toBe("harvested");
  });

  it("未送信の写真は端末の object URL で重なる（URL がなければ null）", () => {
    const photo = newPhotoItem({ id: "p-1", createdAt: new Date("2026-10-23T00:00:00Z"), stemId: "stem-1", storagePath: "org/stem/stem-1/p-1.jpg", contentType: "image/jpeg", takenAt: new Date("2026-10-20T00:15:30Z"), userId: "u", lat: 26.5, lng: 127.9, kind: "bud" });
    const withUrl = applyOutbox(server, [photo], "stem-1", { "p-1": "blob:http://x/1" });
    expect(withUrl.photos).toEqual([{ id: "p-1", kind: "bud", taken_at: "2026-10-20T00:15:30.000Z", url: "blob:http://x/1", taker_name: null, pending: true }]);
    const noUrl = applyOutbox(server, [photo], "stem-1");
    expect(noUrl.photos[0].url).toBeNull();
    const h = buildHistory(noUrl.observations, noUrl.events, noUrl.photos);
    // 2026-10-01 の観測より写真（10-20）が新しいので先頭は写真
    expect(h[0]).toMatchObject({ kind: "photo", pending: true, photo: { id: "p-1", url: null } });
    expect(h[1]).toMatchObject({ kind: "observation", key: "observation:o-server", pending: false });
  });

  it("サーバーの行は変更しない（入力の配列を壊さない）", () => {
    const before = JSON.stringify(server);
    applyOutbox(server, [pendingObs("o-1", "2026-10-23T00:00:00Z")], "stem-1");
    expect(JSON.stringify(server)).toBe(before);
  });
});
