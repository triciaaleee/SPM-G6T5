import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/supabaseAdmin.js", async () => ({ supabaseAdmin: (await import("./helpers/mockDb.js")).supabaseAdminProxy }));

import { setPublisherForTest } from "../lib/rabbitPublisher.js";
import { createFakePublisher } from "../lib/rabbitPublisher.fake.js";
import { equipmentRequestsRouter } from "../routes/equipmentRequests.js";
import { appWith, bearer, callRoute } from "./helpers/app.js";
import { createFakeDb } from "./helpers/fakeDb.js";
import { useDb } from "./helpers/mockDb.js";
import { detailEvent, infoEvent, installWorld, type World } from "./helpers/world.js";

const COORD = bearer("COORD-1", "coordinator");
const ORG = bearer("ORG-1", "organiser");
const TS = bearer("TS-1", "technical_support");
const app = () => appWith("/api/equipment-requests", equipmentRequestsRouter);

let world: World;
let publisher: ReturnType<typeof createFakePublisher>;

const requestRow = (id: number, event_id: number, over: Record<string, any> = {}) => ({
  id, event_id, coordinator_id: "COORD-1", status: "Requested", fulfillment_note: null, created_at: "2026-10-01T00:00:00.000Z", ...over,
});
const itemRow = (id: number, request_id: number, over: Record<string, any> = {}) => ({
  id, request_id, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 0, equipment_catalog_id: 1, ...over,
});
const units = (catalogId: number, ids: number[]) => ids.map((id) => ({ id, status: "Available", equipment_catalog_id: catalogId, label: null }));
const seed = (extra: Record<string, any[]> = {}) => ({
  equipment_catalog: [{ id: 1, name: "Projector" }, { id: 2, name: "Microphone" }],
  equipment_requests: [requestRow(1, 7)],
  equipment_request_items: [itemRow(1, 1)],
  equipment: units(1, [10, 11, 12]),
  ...extra,
});
const NO_FLAG = { flagged: false, reason: null };

beforeEach(() => {
  world = installWorld();
  world.info = [infoEvent(7)];
  world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7) } });
  publisher = createFakePublisher();
  setPublisherForTest(publisher);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  setPublisherForTest(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("PATCH /:id (status update and reservation)", () => {
  const patch = (id: string, body: unknown, token = TS) => request(app()).patch(`/api/equipment-requests/${id}`).set("Authorization", token).send(body as object);
  const WINDOW = { start: Date.parse("2026-12-01T10:00:00.000Z"), end: Date.parse("2026-12-01T12:00:00.000Z") };

  it("reserves the first free units for an Arranged item, passing the claim and the event's window to the database", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await patch("1", { status: "Arranged" });

    expect(res.status).toBe(200);
    expect(db.rpcCalls).toEqual([
      {
        fn: "reserve_equipment_request",
        args: {
          p_request_id: 1, p_status: "Arranged", p_note: null, p_fulfillments: [],
          p_claims: [{ itemId: 1, unitIds: [10, 11] }],
          p_window_start_ms: WINDOW.start, p_window_end_ms: WINDOW.end,
        },
      },
    ]);
    expect(res.body.notified).toBe(true);
    expect(res.body.equipmentRequest).toMatchObject({ id: 1, eventId: 7, status: "Requested" });
  });

  it("notifies the event's current coordinator with the new status and event name", async () => {
    useDb(createFakeDb(seed()));
    world.info = [infoEvent(7, { name: "Nut Fest", coordinatorId: "COORD-NEW" })];
    await patch("1", { status: "Arranged" });
    expect(publisher.published).toEqual([
      {
        type: "equipment.status_changed", eventId: 7, actorId: "TS-1",
        recipients: { userIds: ["COORD-NEW"], roles: [] },
        data: { status: "Arranged", note: null, eventName: "Nut Fest" },
      },
    ]);
  });

  it("falls back to the coordinator on the request and 'Event #id' when events-service can't say", async () => {
    useDb(createFakeDb(seed()));
    // Answers the first lookup (for the window), then fails the second (for the notice).
    let calls = 0;
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: any) => (String(url).includes("venue-booking-info") && ++calls === 2 ? ({ ok: false, status: 500, json: async () => ({}) }) : real(url, init)));
    await patch("1", { status: "Arranged" });
    expect(publisher.published[0].recipients).toEqual({ userIds: ["COORD-1"], roles: [] });
    expect(publisher.published[0].data.eventName).toBe("Event #7");
  });

  it("uses the request's coordinator, and 'Event #id', when the event has no coordinator or name", async () => {
    useDb(createFakeDb(seed()));
    world.info = [infoEvent(7, { name: null, coordinatorId: null })];
    await patch("1", { status: "Arranged" });
    expect(publisher.published[0].recipients.userIds).toEqual(["COORD-1"]);
    expect(publisher.published[0].data.eventName).toBe("Event #7");
  });

  it("reports a failed notice", async () => {
    useDb(createFakeDb(seed()));
    setPublisherForTest({ publish: async () => false });
    expect((await patch("1", { status: "Arranged" })).body.notified).toBe(false);
  });

  it("sends Partially Fulfilled with its note and per-item fulfillments, claiming only the delta", async () => {
    const db = useDb(createFakeDb(seed({
      equipment_request_items: [itemRow(1, 1, { quantity: 4, quantity_fulfilled: 1 }), itemRow(2, 1, { equipment_type: "Microphone", equipment_catalog_id: 2, quantity: 2 })],
      equipment: [...units(1, [10, 11, 12]), ...units(2, [20, 21])],
    })));
    const res = await patch("1", {
      status: "Partially Fulfilled", note: " waiting on 2 ",
      fulfillments: [{ itemId: 1, fulfilledQuantity: 3 }, { itemId: 2, fulfilledQuantity: 0 }],
    });
    expect(res.status).toBe(200);
    expect(db.rpcCalls[0].args).toMatchObject({
      p_status: "Partially Fulfilled", p_note: "waiting on 2",
      p_fulfillments: [{ itemId: 1, fulfilledQuantity: 3 }, { itemId: 2, fulfilledQuantity: 0 }],
      p_claims: [{ itemId: 1, unitIds: [10, 11] }],
    });
  });

  it("never gives one unit to two items of the same call", async () => {
    const db = useDb(createFakeDb(seed({
      equipment_request_items: [itemRow(1, 1, { quantity: 2 }), itemRow(2, 1, { quantity: 2 })],
      equipment: units(1, [10, 11, 12, 13]),
    })));
    const res = await patch("1", { status: "Arranged" });
    expect(res.status).toBe(200);
    expect(db.rpcCalls[0].args.p_claims).toEqual([{ itemId: 1, unitIds: [10, 11] }, { itemId: 2, unitIds: [12, 13] }]);
  });

  it("409s with every shortfall, claiming nothing, when units run out", async () => {
    const db = useDb(createFakeDb(seed({
      equipment_request_items: [itemRow(1, 1, { quantity: 2 }), itemRow(2, 1, { quantity: 2 }), itemRow(3, 1, { quantity: 1, equipment_type: "Microphone", equipment_catalog_id: 2 })],
      equipment: [...units(1, [10, 11, 12]), ...units(2, [20])],
    })));
    const res = await patch("1", { status: "Arranged" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "Not enough equipment available for this change.",
      shortfalls: { 2: { equipmentType: "Projector", availableCount: 1, shortfall: 1 } },
    });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("reverting to Requested releases without asking events-service for a window", async () => {
    const db = useDb(createFakeDb(seed({ equipment_request_items: [itemRow(1, 1, { quantity_fulfilled: 2 })] })));
    const res = await patch("1", { status: "Requested" });
    expect(res.status).toBe(200);
    expect(db.rpcCalls[0].args).toMatchObject({ p_status: "Requested", p_claims: [], p_window_start_ms: null, p_window_end_ms: null });
    // The one events-service call is the post-write lookup for the notice.
    expect(world.urls.filter((u) => u.includes("venue-booking-info"))).toHaveLength(1);
  });

  it("treats an item with no fulfilled count as holding none", async () => {
    const db = useDb(createFakeDb(seed({ equipment_request_items: [itemRow(1, 1, { quantity_fulfilled: undefined })] })));
    await patch("1", { status: "Arranged" });
    expect(db.rpcCalls[0].args.p_claims).toEqual([{ itemId: 1, unitIds: [10, 11] }]);
  });

  it("lowering a partial fulfilment claims nothing", async () => {
    const db = useDb(createFakeDb(seed({ equipment_request_items: [itemRow(1, 1, { quantity_fulfilled: 1 })] })));
    const res = await patch("1", { status: "Partially Fulfilled", note: "n", fulfillments: [{ itemId: 1, fulfilledQuantity: 1 }] });
    expect(res.status).toBe(200);
    expect(db.rpcCalls[0].args.p_claims).toEqual([]);
  });

  it("403s anyone but Technical Support, and 401s without a user", async () => {
    useDb(createFakeDb(seed()));
    const res = await patch("1", { status: "Arranged" }, COORD);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only Technical Support can update a request's status" });
    expect(await callRoute(equipmentRequestsRouter, "patch", "/:id", {})).toEqual({ status: 401, body: { error: "Unauthenticated" } });
    expect((await callRoute(equipmentRequestsRouter, "patch", "/:id", { supabase: {} })).status).toBe(401);
  });

  it.each(["0", "abc", "-1", "01"])("400s the request id %s", async (id) => {
    useDb(createFakeDb(seed()));
    const res = await patch(id, { status: "Arranged" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "A valid request id is required" });
  });

  it("500s when the request can't be read, 404s one that doesn't exist, 409s a cancelled one", async () => {
    const failing = useDb(createFakeDb(seed()));
    failing.failOn("equipment_requests", "select");
    let res = await patch("1", { status: "Arranged" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the equipment request" });

    useDb(createFakeDb(seed()));
    res = await patch("99", { status: "Arranged" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Equipment request not found" });

    useDb(createFakeDb(seed({ equipment_requests: [requestRow(1, 7, { status: "Cancelled" })] })));
    res = await patch("1", { status: "Arranged" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "This request was cancelled, so its status can't be updated." });
  });

  it("500s when the items can't be read, 404s a request with none", async () => {
    const failing = useDb(createFakeDb(seed()));
    failing.failOn("equipment_request_items", "select");
    let res = await patch("1", { status: "Arranged" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment items" });

    useDb(createFakeDb(seed({ equipment_request_items: [] })));
    res = await patch("1", { status: "Arranged" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Equipment request not found" });

    const none = useDb(createFakeDb(seed()));
    none.nullOn("equipment_request_items", "select");
    expect((await patch("1", { status: "Arranged" })).status).toBe(404);
  });

  it("400s an invalid status update, including no body", async () => {
    const db = useDb(createFakeDb(seed()));
    let res = await patch("1", { status: "Done" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Validation failed", fields: { status: "Status must be one of: Requested, Arranged, Partially Fulfilled." } });

    const out = await callRoute(equipmentRequestsRouter, "patch", "/:id", {
      supabase: db, user: { id: "TS-1", role: "technical_support" }, params: { id: "1" }, body: undefined,
    });
    expect(out.status).toBe(400);
    res = await patch("1", { status: "Partially Fulfilled", note: "n", fulfillments: [] });
    expect(res.body.fields).toEqual({ "fulfillments[1]": "Enter how many of this item were fulfilled." });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("502s, 404s or 409s according to what events-service says about the event when reserving", async () => {
    const db = useDb(createFakeDb(seed()));
    world.infoOk = false;
    let res = await patch("1", { status: "Arranged" });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the event" });

    world.infoOk = true;
    world.info = [];
    res = await patch("1", { status: "Arranged" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event not found" });

    world.info = [infoEvent(7, { proposedDate: null })];
    res = await patch("1", { status: "Arranged" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "This event has no date or time set yet, so equipment can't be reserved." });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("409s an item with no catalog link that would need reserving, naming it", async () => {
    const db = useDb(createFakeDb(seed({ equipment_request_items: [itemRow(1, 1, { equipment_catalog_id: null, equipment_type: "Cable" })] })));
    const res = await patch("1", { status: "Arranged" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Cable isn't linked to an equipment catalog item, so it can't be reserved." });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("lets an unlinked item through when nothing is reserved for it", async () => {
    const db = useDb(createFakeDb(seed({ equipment_request_items: [itemRow(1, 1, { equipment_catalog_id: null, quantity_fulfilled: 2 })] })));
    expect((await patch("1", { status: "Requested" })).status).toBe(200);
    expect(db.rpcCalls).toHaveLength(1);
  });

  describe("when the database function refuses", () => {
    const refuse = (message: unknown) => {
      const db = useDb(createFakeDb(seed()));
      db.onRpc("reserve_equipment_request", () => ({ data: null, error: message === undefined ? {} : { message } }));
      return db;
    };

    it("409s a stock shortage", async () => {
      refuse("Not enough stock for Projector");
      const res = await patch("1", { status: "Arranged" });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "Not enough stock available to make this change." });
    });

    it.each(["unit 10 is no longer available", "unit 10 is already reserved", "unit 10 is not the requested type", "overlapping dates", "unit unavailable during the event"])(
      "409s a unit that was taken meanwhile: %s",
      async (message) => {
        refuse(message);
        const res = await patch("1", { status: "Arranged" });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: "Some of that equipment was just taken or changed. Check availability and try again." });
      },
    );

    it("500s anything else, with or without a message", async () => {
      for (const message of ["deadlock detected", undefined]) {
        refuse(message);
        const res = await patch("1", { status: "Arranged" });
        expect(res.status).toBe(500);
        expect(res.body).toEqual({ error: "Failed to update the equipment request" });
      }
      expect(publisher.published).toHaveLength(0);
    });
  });

  it("500s when the updated request or its items can't be read back, notifying nobody", async () => {
    const request = useDb(createFakeDb(seed()));
    request.failOn("equipment_requests", "select", -1, (c) => c.columns === "id, event_id, coordinator_id, status, fulfillment_note, created_at");
    let res = await patch("1", { status: "Arranged" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the updated equipment request" });

    const none = useDb(createFakeDb(seed()));
    none.nullOn("equipment_requests", "select", -1, (c) => c.columns === "id, event_id, coordinator_id, status, fulfillment_note, created_at");
    expect((await patch("1", { status: "Arranged" })).status).toBe(500);

    const items = useDb(createFakeDb(seed()));
    let reads = 0;
    items.failOn("equipment_request_items", "select", -1, () => ++reads === 2);
    res = await patch("1", { status: "Arranged" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment items" });
    expect(publisher.published).toHaveLength(0);
  });

  it("answers with the units now reserved and a flag when the reservation clashes", async () => {
    world.info = [infoEvent(7), infoEvent(8, { startTime: "11:00", endTime: "13:00" })];
    useDb(createFakeDb(seed({
      equipment: [{ id: 10, status: "Available", equipment_catalog_id: 1, label: "S-10" }],
      equipment_booking: [
        { id: 1, equipment_id: 10, event_id: 7, request_item_id: 1, status: "Reserved" },
        { id: 2, equipment_id: 10, event_id: 8, request_item_id: 50, status: "Reserved" },
      ],
    })));
    const res = await patch("1", { status: "Requested" });
    const item = res.body.equipmentRequest.items[0];
    expect(item.reservedUnits).toEqual([{ id: 10, label: "S-10" }]);
    expect(item.reservationFlag.flagged).toBe(true);
  });

  it("treats an empty read of the items as none in the answer", async () => {
    const db = useDb(createFakeDb(seed()));
    let reads = 0;
    db.nullOn("equipment_request_items", "select", -1, () => ++reads === 2);
    const res = await patch("1", { status: "Arranged" });
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequest.items).toEqual([]);
  });
});

describe("POST /events/:eventId/release", () => {
  const post = (id: string, token = ORG) => request(app()).post(`/api/equipment-requests/events/${id}/release`).set("Authorization", token);

  beforeEach(() => world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { status: "Cancelled" }) } }));

  it("releases the cancelled event's equipment for its organiser", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await post("7");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ released: true });
    expect(db.rpcCalls).toEqual([{ fn: "release_equipment_for_event", args: { p_event_id: 7 } }]);
  });

  it("401s without a user, 400s a bad event id", async () => {
    useDb(createFakeDb(seed()));
    expect(await callRoute(equipmentRequestsRouter, "post", "/events/:eventId/release", {})).toEqual({ status: 401, body: { error: "Unauthenticated" } });
    expect((await callRoute(equipmentRequestsRouter, "post", "/events/:eventId/release", { supabase: {} })).status).toBe(401);
    for (const id of ["0", "abc", "-1"]) {
      const res = await post(id);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "A valid eventId is required" });
    }
  });

  it("404s an event the caller can't see, 502s when events-service fails", async () => {
    useDb(createFakeDb(seed()));
    world.eventDetail.set(7, { status: 404 });
    let res = await post("7");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event not found" });
    world.eventDetail.set(7, { status: 500 });
    res = await post("7");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the event" });
  });

  it("403s anyone but an organiser, without releasing", async () => {
    const db = useDb(createFakeDb(seed()));
    for (const token of [COORD, TS]) {
      const res = await post("7", token);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Only the organiser can release an event's equipment reservations" });
    }
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("409s an event that isn't cancelled", async () => {
    world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { status: "Planning" }) } });
    const db = useDb(createFakeDb(seed()));
    const res = await post("7");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Equipment reservations can only be released once the event is cancelled." });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("500s when the release fails", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("release_equipment_for_event", () => ({ data: null, error: { message: "boom" } }));
    const res = await post("7");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to release the event's equipment reservations" });
  });
});

describe("POST /flag-for-event/:eventId", () => {
  const post = (id: string, body: unknown, token = COORD) => request(app()).post(`/api/equipment-requests/flag-for-event/${id}`).set("Authorization", token).send(body as object);

  it("falls back to 'Event #id' for an unnamed event, and reports a failed notice", async () => {
    world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { submitted_details: undefined }) } });
    useDb(createFakeDb(seed()));
    setPublisherForTest({ publish: async () => false });
    expect((await post("7", { reason: "r" })).body.notified).toBe(false);
    setPublisherForTest(publisher);
    await post("7", { reason: "r" });
    expect(publisher.published[0].data.eventName).toBe("Event #7");
  });

  it("flags nothing, and notifies nobody, when the event has no requests", async () => {
    useDb(createFakeDb(seed({ equipment_requests: [] })));
    const res = await post("7", { reason: "r" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flaggedRequestIds: [], notified: false });
    expect(publisher.published).toHaveLength(0);
  });

  it("treats an empty result as nothing flagged", async () => {
    const db = useDb(createFakeDb(seed()));
    db.nullOn("equipment_requests", "update");
    const res = await post("7", { reason: "r" });
    expect(res.body).toEqual({ flaggedRequestIds: [], notified: false });
  });

  it("401s without a user, 400s a bad event id or a missing reason", async () => {
    const db = useDb(createFakeDb(seed()));
    expect(await callRoute(equipmentRequestsRouter, "post", "/flag-for-event/:eventId", {})).toEqual({ status: 401, body: { error: "Unauthenticated" } });
    expect((await callRoute(equipmentRequestsRouter, "post", "/flag-for-event/:eventId", { supabase: {} })).status).toBe(401);
    for (const id of ["0", "abc"]) {
      const res = await post(id, { reason: "r" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "A valid eventId is required" });
    }
    for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: 5 }]) {
      const res = await post("7", body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "A reason is required" });
    }
    const noBody = await callRoute(equipmentRequestsRouter, "post", "/flag-for-event/:eventId", {
      supabase: db, user: { id: "COORD-1", role: "coordinator" }, params: { eventId: "7" }, body: undefined,
    });
    expect(noBody).toEqual({ status: 400, body: { error: "A reason is required" } });
    expect(db.writes("equipment_requests")).toHaveLength(0);
  });

  it("404s an unseen event, 502s when events-service fails, 403s a coordinator who isn't assigned", async () => {
    const db = useDb(createFakeDb(seed()));
    world.eventDetail.set(7, { status: 404 });
    let res = await post("7", { reason: "r" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event not found" });

    world.eventDetail.set(7, { status: 500 });
    res = await post("7", { reason: "r" });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the event" });

    world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { coordinator_id: "COORD-2" }) } });
    res = await post("7", { reason: "r" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only the event's assigned coordinator can flag its equipment requests" });
    expect(db.writes("equipment_requests")).toHaveLength(0);
  });

  it("500s when the flag can't be saved, notifying nobody", async () => {
    const db = useDb(createFakeDb(seed()));
    db.failOn("equipment_requests", "update");
    const res = await post("7", { reason: "r" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to flag the event's equipment requests" });
    expect(publisher.published).toHaveLength(0);
  });
});

describe("PUT /:id/items and POST /:id/cancel: who may change a request", () => {
  const put = (id: string, body: unknown, token = COORD) => request(app()).put(`/api/equipment-requests/${id}/items`).set("Authorization", token).send(body as object);
  const cancel = (id: string, token = COORD) => request(app()).post(`/api/equipment-requests/${id}/cancel`).set("Authorization", token);
  const items = { items: [{ itemId: 1, equipmentCatalogId: 1, quantity: 3 }] };

  const both: [string, (id: string, token?: string) => Promise<any>, "put" | "post", string][] = [
    ["amend", (id, token) => put(id, items, token), "put", "/:id/items"],
    ["cancel", (id, token) => cancel(id, token), "post", "/:id/cancel"],
  ];

  describe.each(both)("%s", (_name, call, method, path) => {
    it("401s without a client or user", async () => {
      expect(await callRoute(equipmentRequestsRouter, method, path, {})).toEqual({ status: 401, body: { error: "Unauthenticated" } });
      expect((await callRoute(equipmentRequestsRouter, method, path, { supabase: {} })).status).toBe(401);
      expect((await callRoute(equipmentRequestsRouter, method, path, { user: { id: "u", role: "coordinator" } })).status).toBe(401);
    });

    it("403s anyone but a coordinator", async () => {
      useDb(createFakeDb(seed()));
      const res = await call("1", TS);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Only the assigned coordinator can change an equipment request" });
    });

    it.each(["0", "abc", "-1"])("400s the request id %s", async (id) => {
      useDb(createFakeDb(seed()));
      const res = await call(id);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "A valid request id is required" });
    });

    it("500s when the request can't be read, 404s one that doesn't exist", async () => {
      const failing = useDb(createFakeDb(seed()));
      failing.failOn("equipment_requests", "select");
      let res = await call("1");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Failed to load the equipment request" });

      useDb(createFakeDb(seed()));
      res = await call("99");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Equipment request not found" });
    });

    it("404s an unseen event, 502s when events-service fails", async () => {
      useDb(createFakeDb(seed()));
      world.eventDetail.set(7, { status: 403 });
      let res = await call("1");
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Event not found" });
      world.eventDetail.set(7, { status: 500 });
      res = await call("1");
      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "Failed to load the event" });
    });

    it("403s a coordinator who isn't assigned to the event", async () => {
      useDb(createFakeDb(seed()));
      world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { coordinator_id: "COORD-2" }) } });
      const res = await call("1");
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Only the assigned coordinator can change an equipment request" });
    });

    it.each(["Draft", "Unassigned", "Requested", "Clarification Requested", "Safety Review", "Confirmed", "Rejected", "Completed", "Cancelled"])(
      "409s an event in %s",
      async (status) => {
        const db = useDb(createFakeDb(seed()));
        world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { status }) } });
        const res = await call("1");
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: "Equipment requests can only be changed while the event is in Planning or Needs Review." });
        expect(db.rpcCalls).toHaveLength(0);
      },
    );

    it("409s a request that was already cancelled", async () => {
      const db = useDb(createFakeDb(seed({ equipment_requests: [requestRow(1, 7, { status: "Cancelled" })] })));
      const res = await call("1");
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "This equipment request has been cancelled." });
      expect(db.rpcCalls).toHaveLength(0);
    });
  });
});

describe("PUT /:id/items", () => {
  const put = (id: string, body: unknown, token = COORD) => request(app()).put(`/api/equipment-requests/${id}/items`).set("Authorization", token).send(body as object);
  const items = { items: [{ itemId: 1, equipmentCatalogId: 1, quantity: 3 }, { equipmentCatalogId: 2, quantity: 1 }] };
  const outcome = (changes: unknown[]) => ({ data: { changes }, error: null });

  it("amends through the database function, naming each type from the catalog", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("amend_equipment_request", () => outcome([]));
    const res = await put("1", items);

    expect(res.status).toBe(200);
    expect(db.rpcCalls).toEqual([
      {
        fn: "amend_equipment_request",
        args: {
          p_request_id: 1,
          p_items: [
            { itemId: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 3 },
            { itemId: null, equipmentCatalogId: 2, equipmentType: "Microphone", quantity: 1 },
          ],
        },
      },
    ]);
  });

  it("works on a Partially Fulfilled request in Needs Review", async () => {
    const db = useDb(createFakeDb(seed({ equipment_requests: [requestRow(1, 7, { status: "Partially Fulfilled" })] })));
    world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { status: "Needs Review" }) } });
    expect((await put("1", items)).status).toBe(200);
    expect(db.rpcCalls).toHaveLength(1);
  });

  it("tells Technical Support exactly what changed and how many units were released", async () => {
    const changes = [
      { kind: "quantity", equipmentType: "Projector", from: 2, to: 1, released: 1 },
      { kind: "added", equipmentType: "Microphone", quantity: 1, released: 0 },
      { kind: "removed", equipmentType: "Cable", released: undefined },
    ];
    const db = useDb(createFakeDb(seed()));
    db.onRpc("amend_equipment_request", () => outcome(changes));
    const res = await put("1", items);

    expect(res.body.released).toBe(1);
    expect(res.body.notified).toBe(true);
    expect(res.body.changes).toEqual(JSON.parse(JSON.stringify(changes)));
    expect(publisher.published).toEqual([
      {
        type: "equipment.amended", eventId: 7, actorId: "COORD-1",
        recipients: { userIds: [], roles: ["technical_support"] },
        data: { eventName: "Fest", changes: JSON.parse(JSON.stringify(changes)), released: 1 },
      },
    ]);
  });

  it("tells nobody when nothing changed, or the function reported no changes list", async () => {
    const db = useDb(createFakeDb(seed()));
    for (const data of [{ changes: [] }, null, {}]) {
      db.onRpc("amend_equipment_request", () => ({ data, error: null }));
      const res = await put("1", items);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ changes: [], released: 0, notified: false });
    }
    expect(publisher.published).toHaveLength(0);
  });

  it("reports a failed notice", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("amend_equipment_request", () => outcome([{ kind: "added", equipmentType: "Microphone", quantity: 1, released: 0 }]));
    setPublisherForTest({ publish: async () => false });
    expect((await put("1", items)).body.notified).toBe(false);
  });

  it("falls back to 'Event #id' for an unnamed event", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("amend_equipment_request", () => outcome([{ kind: "added", equipmentType: "x", released: 0 }]));
    world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { submitted_details: {} }) } });
    await put("1", items);
    expect(publisher.published[0].data.eventName).toBe("Event #7");
  });

  it("answers with the request as it now stands", async () => {
    useDb(createFakeDb(seed({ equipment_request_items: [itemRow(1, 1, { quantity: 3 })] })));
    const res = await put("1", items);
    expect(res.body.equipmentRequest).toEqual({
      id: 1, eventId: 7, status: "Requested", fulfillmentNote: null, createdAt: "2026-10-01T00:00:00.000Z",
      items: [{ id: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 3, quantityFulfilled: 0, reservationFlag: NO_FLAG, reservedUnits: [] }],
    });
  });

  it("409s a fully arranged request, without calling the database", async () => {
    const db = useDb(createFakeDb(seed({ equipment_requests: [requestRow(1, 7, { status: "Arranged" })] })));
    const res = await put("1", items);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "A fully arranged request can't be amended. Cancel it and raise a new one." });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("400s invalid items, including no body", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await put("1", { items: [] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Validation failed", fields: { items: "At least one equipment item is required." } });

    const out = await callRoute(equipmentRequestsRouter, "put", "/:id/items", {
      supabase: db, user: { id: "COORD-1", role: "coordinator" }, params: { id: "1" }, headers: { authorization: "Bearer x" }, body: undefined,
    });
    expect(out.status).toBe(400);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("500s when the catalog can't be read, 400s catalog entries that don't exist", async () => {
    const failing = useDb(createFakeDb(seed()));
    failing.failOn("equipment_catalog", "select");
    let res = await put("1", items);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to validate the equipment items" });

    const db = useDb(createFakeDb(seed()));
    res = await put("1", { items: [{ equipmentCatalogId: 1, quantity: 1 }, { equipmentCatalogId: 99, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Validation failed", fields: { "items[1].equipmentCatalogId": "Select a valid equipment type." } });
    expect(db.rpcCalls).toHaveLength(0);

    const none = useDb(createFakeDb(seed()));
    none.nullOn("equipment_catalog", "select");
    expect((await put("1", items)).status).toBe(400);
  });

  it("maps the function's refusals", async () => {
    const db = useDb(createFakeDb(seed()));
    const refuse = (message: unknown) => db.onRpc("amend_equipment_request", () => ({ data: null, error: message === undefined ? {} : { message } }));

    refuse("request cannot be amended");
    let res = await put("1", items);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "This request can no longer be amended." });

    refuse("Unknown item 5");
    res = await put("1", items);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Validation failed", fields: { items: "One of these items isn't on this request." } });

    for (const message of ["deadlock", undefined]) {
      refuse(message);
      res = await put("1", items);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Failed to amend the equipment request" });
    }
    expect(publisher.published).toHaveLength(0);
  });

  it("500s when the amended request can't be read back", async () => {
    const db = useDb(createFakeDb(seed()));
    let reads = 0;
    db.failOn("equipment_requests", "select", -1, (c) => c.columns?.includes("coordinator_id") === true && ++reads === 1);
    let res = await put("1", items);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the updated equipment request" });

    const none = useDb(createFakeDb(seed()));
    none.nullOn("equipment_requests", "select", -1, (c) => c.columns?.includes("coordinator_id") === true);
    expect((await put("1", items)).status).toBe(500);

    const failingItems = useDb(createFakeDb(seed()));
    failingItems.failOn("equipment_request_items", "select");
    res = await put("1", items);
    expect(res.status).toBe(500);
  });

  it("answers with no items when the item read comes back empty", async () => {
    const db = useDb(createFakeDb(seed()));
    db.nullOn("equipment_request_items", "select");
    const res = await put("1", items);
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequest.items).toEqual([]);
  });
});

describe("POST /:id/cancel", () => {
  const cancel = (id: string, token = COORD) => request(app()).post(`/api/equipment-requests/${id}/cancel`).set("Authorization", token);

  it("releases nothing when the function reports no list, and falls back to 'Event #id'", async () => {
    const db = useDb(createFakeDb(seed()));
    world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { submitted_details: undefined }) } });
    for (const data of [null, {}]) {
      db.onRpc("release_equipment_for_request", () => ({ data, error: null }));
      const res = await cancel("1");
      expect(res.body.released).toEqual([]);
    }
    expect(publisher.published[0].data).toEqual({ eventName: "Event #7", reason: "coordinator_cancelled", released: [] });
  });

  it("reports a failed notice", async () => {
    useDb(createFakeDb(seed()));
    setPublisherForTest({ publish: async () => false });
    expect((await cancel("1")).body.notified).toBe(false);
  });

  it("maps the function's refusals", async () => {
    const db = useDb(createFakeDb(seed()));
    db.onRpc("release_equipment_for_request", () => ({ data: null, error: { message: "request already cancelled" } }));
    let res = await cancel("1");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "This equipment request has been cancelled." });

    for (const error of [{ message: "deadlock" }, {}]) {
      db.onRpc("release_equipment_for_request", () => ({ data: null, error }));
      res = await cancel("1");
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Failed to cancel the equipment request" });
    }
    expect(publisher.published).toHaveLength(0);
  });

  it("500s when the cancelled request can't be read back", async () => {
    const db = useDb(createFakeDb(seed()));
    db.failOn("equipment_requests", "select", -1, (c) => c.columns?.includes("coordinator_id") === true);
    const res = await cancel("1");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the updated equipment request" });
  });
});
