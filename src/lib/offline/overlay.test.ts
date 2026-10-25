import { describe, expect, it } from "vitest";
import { cumulativeLeaves } from "../leaves";
import { buildHistory, canRecordLeaves, toLeafObservations, type EventRow, type ObservationRow, type PhotoRow } from "../stems/records";
import { canRecordEvent } from "../stemEvents";
import { cumulativeLeavesAsOf } from "../suckers";
import {
  newAdoptSuckerItem,
  newLeavesRemovedItem,
  newObservationItem,
  newPhotoItem,
  newRemoveSuckerItem,
  newStemEventItem,
  newSuckerEmergedItem,
  outboxItemLabel,
} from "./items";
import { applyOutbox, applyOutboxToMat, itemsForStem, matHoldKey, matServerIds, matSettledKey, type MatStemRow } from "./overlay";

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

describe("吸芽の発生（2-1）の重ね合わせ", () => {
  const suckerItem = (id: string, createdAt: string, parentStemId = "stem-1", suckerStemId = "sucker-1") =>
    newSuckerEmergedItem({
      id,
      createdAt: new Date(createdAt),
      parentStemId,
      suckerStemId,
      occurredAt: "2026-10-24T16:00:00Z", // JST 2026-10-25 01:00
      payload: { parent_cumulative_leaves: 18, earliest_at: null, direction: "NE", sucker_type: "sword" },
    });

  it("outbox 項目は親茎に紐づき、payload に sucker_stem_id を含む", () => {
    const item = suckerItem("e-1", "2026-10-25T00:00:00Z");
    expect(item.stem_id).toBe("stem-1");
    expect(item.kind).toBe("event");
    expect(item.payload).toMatchObject({
      method: "record_sucker_emerged",
      id: "e-1",
      type: "sucker_emerged",
      sucker_stem_id: "sucker-1",
      parent_stem_id: "stem-1",
      payload: { sucker_stem_id: "sucker-1", parent_cumulative_leaves: 18, direction: "NE", sucker_type: "sword" },
    });
    expect(outboxItemLabel(item)).toBe("吸芽");
  });

  it("親茎の履歴に未同期のイベントとして重なり、親の状態は変わらない", () => {
    const r = applyOutbox(server, [suckerItem("e-1", "2026-10-25T00:00:00Z")], "stem-1");
    expect(r.status).toBe("active");
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ id: "e-1", type: "sucker_emerged", pending: true });
    const h = buildHistory(r.observations, r.events, r.photos);
    const e = h.find((x) => x.key === "event:e-1");
    expect([e?.label, e?.valueText, e?.pending]).toEqual(["吸芽", "北東・剣葉・親の累計 18 枚", true]);
  });

  const matStems: MatStemRow[] = [
    {
      id: "stem-1",
      generation: 1,
      status: "active",
      started_at: "2026-01-10",
      initial_leaf_count: 4,
      parent_stem_id: null,
      observations: [{ id: "o-server", type: "leaves_new", value: 2, observed_at: "2026-10-01T00:00:00Z" }],
    },
  ];

  it("株の詳細: 未送信の吸芽が status=sucker・pending の茎として足される（generation=親+1、started_at は日本時間の日付）", () => {
    const r = applyOutboxToMat(matStems, [suckerItem("e-1", "2026-10-25T00:00:00Z")]);
    expect(r).toHaveLength(2);
    expect(r[1]).toEqual({
      id: "sucker-1",
      generation: 2,
      status: "sucker",
      started_at: "2026-10-25",
      initial_leaf_count: 0,
      parent_stem_id: "stem-1",
      observations: [],
      pending: true,
    });
    expect(r[0].pending).toBeUndefined();
  });

  it("株の詳細: サーバーに同じ茎があれば二重に足さない", () => {
    const withSucker: MatStemRow[] = [
      ...matStems,
      { id: "sucker-1", generation: 2, status: "sucker", started_at: "2026-10-25", initial_leaf_count: 0, parent_stem_id: "stem-1", observations: [] },
    ];
    const r = applyOutboxToMat(withSucker, [suckerItem("e-1", "2026-10-25T00:00:00Z")]);
    expect(r).toHaveLength(2);
    expect(r.every((s) => s.pending === undefined)).toBe(true);
  });

  it("株の詳細: 未送信の観測が累計に加わり、未送信の出蕾で見かけの状態が flowered になる。他の茎の項目は無視する", () => {
    const items = [
      pendingObs("o-1", "2026-10-23T00:00:00Z"),
      pendingObs("o-server", "2026-10-23T00:00:01Z"), // 同期済み
      pendingObs("o-x", "2026-10-23T00:00:02Z", "other-stem"),
      newStemEventItem({ id: "e-bud", createdAt: new Date("2026-10-24T00:00:00Z"), stemId: "stem-1", type: "bud_emerged", occurredAt: "2026-10-24T00:00:00Z", payload: {} }),
    ];
    const r = applyOutboxToMat(matStems, items);
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("flowered");
    expect(r[0].observations.map((o) => [o.id, o.pending])).toEqual([
      ["o-server", undefined],
      ["o-1", true],
    ]);
    expect(cumulativeLeavesAsOf(4, r[0].observations, "2026-10-25")).toBe(7);
    // 元の配列は変えない
    expect(matStems[0].observations).toHaveLength(1);
    expect(matStems[0].status).toBe("active");
  });

  it("保持の鍵: 観測は観測の id、吸芽は吸芽の茎の id、それ以外は保持しない", () => {
    expect(matHoldKey(pendingObs("o-1", "2026-10-23T00:00:00Z"))).toBe("o-1");
    expect(matHoldKey(suckerItem("e-1", "2026-10-25T00:00:00Z"))).toBe("sucker-1");
    expect(
      matHoldKey(newStemEventItem({ id: "e-b", createdAt: new Date(), stemId: "stem-1", type: "bagged", occurredAt: "2026-10-24T00:00:00Z", payload: {} })),
    ).toBeNull();
  });
});

describe("吸芽の採用・芽かき（2-2）", () => {
  const sucker: MatStemRow = {
    id: "sucker-1",
    generation: 2,
    status: "sucker",
    started_at: "2026-10-01",
    initial_leaf_count: 0,
    parent_stem_id: "stem-1",
    observations: [],
  };
  const parent: MatStemRow = {
    id: "stem-1",
    generation: 1,
    status: "active",
    started_at: "2026-01-10",
    initial_leaf_count: 4,
    parent_stem_id: null,
    observations: [],
  };
  const adopt = (id: string, createdAt: string, stemId = "sucker-1", initialLeafCount = 7) =>
    newAdoptSuckerItem({ id, createdAt: new Date(createdAt), stemId, occurredAt: createdAt, initialLeafCount });
  const remove = (id: string, createdAt: string, stemId = "sucker-1") =>
    newRemoveSuckerItem({ id, createdAt: new Date(createdAt), stemId, occurredAt: createdAt });

  it("outbox 項目: 採用は adopt_sucker（payload は events.payload と同じ {initial_leaf_count}）、芽かきは remove_sucker。stem_id は吸芽", () => {
    const a = adopt("e-a", "2026-10-25T00:00:00Z");
    expect(a).toMatchObject({
      id: "e-a",
      stem_id: "sucker-1",
      kind: "event",
      payload: { method: "adopt_sucker", id: "e-a", type: "sucker_adopted", stem_id: "sucker-1", payload: { initial_leaf_count: 7 } },
    });
    expect(outboxItemLabel(a)).toBe("吸芽の採用");
    const r = remove("e-r", "2026-10-25T00:00:00Z");
    expect(r).toMatchObject({ stem_id: "sucker-1", payload: { method: "remove_sucker", type: "sucker_removed", payload: {}, note: null } });
    expect(outboxItemLabel(r)).toBe("芽かき");
  });

  it("株の詳細: 未送信の採用で見かけの状態が active になり、初期葉数が累計葉数の起点になる", () => {
    const r = applyOutboxToMat([parent, sucker], [adopt("e-a", "2026-10-25T00:00:00Z")]);
    expect(r[1]).toMatchObject({ id: "sucker-1", status: "active", initial_leaf_count: 7 });
    expect(r[0].status).toBe("active");
    // 元の配列は変えない
    expect(sucker.status).toBe("sucker");
    expect(sucker.initial_leaf_count).toBe(0);
  });

  it("株の詳細: 未送信の芽かきで見かけの状態が removed になる", () => {
    const r = applyOutboxToMat([parent, sucker], [remove("e-r", "2026-10-25T00:00:00Z")]);
    expect(r[1].status).toBe("removed");
  });

  it("株の詳細: サーバーで既に吸芽でない（同期済み）なら重ねない", () => {
    const synced = { ...sucker, status: "active", initial_leaf_count: 5 };
    const r = applyOutboxToMat([parent, synced], [adopt("e-a", "2026-10-25T00:00:00Z", "sucker-1", 9), remove("e-r", "2026-10-25T00:00:01Z")]);
    expect(r[1]).toMatchObject({ status: "active", initial_leaf_count: 5 });
  });

  it("茎の画面: 未送信の採用・芽かきは履歴に未同期のイベントとして重なり、状態が変わる", () => {
    const base = { status: "sucker", observations: [], events: [], photos: [] };
    const a = applyOutbox(base, [adopt("e-a", "2026-10-25T00:00:00Z")], "sucker-1");
    expect(a.status).toBe("active");
    expect(a.events[0]).toMatchObject({ id: "e-a", type: "sucker_adopted", pending: true });
    const h = buildHistory(a.observations, a.events, a.photos);
    expect(h.find((x) => x.key === "event:e-a")).toMatchObject({ label: "吸芽の採用", valueText: "初期葉数 7 枚" });
    const r = applyOutbox(base, [remove("e-r", "2026-10-25T00:00:00Z")], "sucker-1");
    expect(r.status).toBe("removed");
    expect(canRecordLeaves(r.status)).toBe(false);
  });

  it("保持の鍵: 採用・芽かきは matSettledKey。serverIds は吸芽でなくなった茎の鍵を含む", () => {
    expect(matHoldKey(adopt("e-a", "2026-10-25T00:00:00Z"))).toBe(matSettledKey("sucker-1"));
    expect(matHoldKey(remove("e-r", "2026-10-25T00:00:00Z"))).toBe(matSettledKey("sucker-1"));
    const before = matServerIds([parent, sucker]);
    expect(before.has("sucker-1")).toBe(true);
    expect(before.has(matSettledKey("sucker-1"))).toBe(false);
    expect(before.has(matSettledKey("stem-1"))).toBe(true);
    const after = matServerIds([parent, { ...sucker, status: "removed" }]);
    expect(after.has(matSettledKey("sucker-1"))).toBe(true);
  });
});
