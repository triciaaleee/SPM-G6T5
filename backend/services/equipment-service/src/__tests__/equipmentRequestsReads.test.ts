import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../lib/supabaseAdmin.js", async () => ({ supabaseAdmin: (await import("./helpers/mockDb.js")).supabaseAdminProxy }));

import { setPublisherForTest } from "../lib/rabbitPublisher.js";
import { createFakePublisher } from "../lib/rabbitPublisher.fake.js";
import { equipmentRequestsRouter } from "../routes/equipmentRequests.js";
import { appWith, bearer, callRoute } from "./helpers/app.js";
import { createFakeDb, type FakeDb } from "./helpers/fakeDb.js";
import { useDb } from "./helpers/mockDb.js";
import { detailEvent, infoEvent, installWorld, type World } from "./helpers/world.js";

const COORD = bearer("COORD-1", "coordinator");
const ORG = bearer("ORG-1", "organiser");
const SAFETY = bearer("SAFE-1", "safety_officer");
const TS = bearer("TS-1", "technical_support");
const ATTENDEE = bearer("ATT-1", "attendee");
const app = () => appWith("/api/equipment-requests", equipmentRequestsRouter);

let world: World;
let publisher: ReturnType<typeof createFakePublisher>;

const requestRow = (id: number, event_id: number, over: Record<string, any> = {}) => ({
  id, event_id, coordinator_id: "COORD-1", status: "Requested", fulfillment_note: null, created_at: `2026-10-0${id}T00:00:00.000Z`, ...over,
});
const itemRow = (id: number, request_id: number, over: Record<string, any> = {}) => ({
  id, request_id, equipment_type: "Projector", quantity: 2, quantity_fulfilled: 0, equipment_catalog_id: 1, ...over,
});
const seed = (extra: Record<string, any[]> = {}) => ({
  equipment_catalog: [{ id: 1, name: "Projector" }, { id: 2, name: "Microphone" }],
  ...extra,
});

beforeEach(() => {
  world = installWorld();
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

/** An insert returns what the database defaults would have filled in. */
function withDefaults(db: FakeDb) {
  db.mapOn("equipment_requests", "insert", (r) => ({ ...r, data: r.data && { ...r.data, status: "Requested", fulfillment_note: null, created_at: "2026-10-28T04:00:00.000Z" } }));
  return db;
}

describe("POST /", () => {
  const post = (body: unknown, token = COORD) => request(app()).post("/api/equipment-requests").set("Authorization", token).send(body as object);
  const good = { eventId: 7, items: [{ equipmentCatalogId: 1, quantity: 2 }, { equipmentCatalogId: 2, quantity: 1 }] };

  beforeEach(() => world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7) } }));

  it("records the request and one item per row, naming each from the catalog", async () => {
    const db = useDb(withDefaults(createFakeDb(seed())));
    const res = await post(good);

    expect(res.status).toBe(201);
    // Defaults (status, created_at) come from the database, which the fake doesn't model.
    expect(db.rows("equipment_requests")).toEqual([{ id: 1, event_id: 7, coordinator_id: "COORD-1" }]);
    expect(db.rows("equipment_request_items")).toEqual([
      { id: 1, request_id: 1, equipment_catalog_id: 1, equipment_type: "Projector", quantity: 2 },
      { id: 2, request_id: 1, equipment_catalog_id: 2, equipment_type: "Microphone", quantity: 1 },
    ]);
    expect(res.body.equipmentRequest).toEqual({
      id: 1, eventId: 7, status: "Requested", fulfillmentNote: null, createdAt: "2026-10-28T04:00:00.000Z",
      items: [
        { id: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 0, reservationFlag: { flagged: false, reason: null }, reservedUnits: [] },
        { id: 2, equipmentCatalogId: 2, equipmentType: "Microphone", quantity: 1, quantityFulfilled: 0, reservationFlag: { flagged: false, reason: null }, reservedUnits: [] },
      ],
    });
    expect(res.body.notified).toBe(true);
  });

  it("tells Technical Support, naming the event and counting the items", async () => {
    useDb(withDefaults(createFakeDb(seed())));
    await post(good);
    expect(publisher.published).toEqual([
      {
        type: "equipment.requested", eventId: 7, actorId: "COORD-1",
        recipients: { userIds: [], roles: ["technical_support"] },
        data: { eventName: "Fest", itemCount: 2 },
      },
    ]);
  });

  it("falls back to 'Event #id' when the event has no name, and reports a failed notice", async () => {
    world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { submitted_details: undefined }) } });
    setPublisherForTest({ publish: async () => false });
    useDb(withDefaults(createFakeDb(seed())));
    const res = await post(good);
    expect(res.status).toBe(201);
    expect(res.body.notified).toBe(false);
    setPublisherForTest(publisher);
    await post(good);
    expect(publisher.published[0].data.eventName).toBe("Event #7");
  });

  it("accepts the event in Needs Review, with the event id as a string", async () => {
    world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { status: "Needs Review" }) } });
    useDb(withDefaults(createFakeDb(seed())));
    expect((await post({ ...good, eventId: "7" })).status).toBe(201);
  });

  it("merges items of the same catalog entry into one catalog lookup", async () => {
    const db = useDb(withDefaults(createFakeDb(seed())));
    await post({ eventId: 7, items: [{ equipmentCatalogId: 1, quantity: 1 }, { equipmentCatalogId: 1, quantity: 3 }] });
    expect(db.calls.find((c) => c.table === "equipment_catalog")!.filters).toEqual([{ col: "id", kind: "in", value: [1] }]);
    expect(db.rows("equipment_request_items")).toHaveLength(2);
  });

  it("403s anyone but a coordinator", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await post(good, TS);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only coordinators can record equipment requirements" });
    expect(db.writes("equipment_requests")).toHaveLength(0);
  });

  it("401s without a client or user", async () => {
    expect(await callRoute(equipmentRequestsRouter, "post", "/", {})).toEqual({ status: 401, body: { error: "Unauthenticated" } });
    expect((await callRoute(equipmentRequestsRouter, "post", "/", { supabase: {} })).status).toBe(401);
    expect((await callRoute(equipmentRequestsRouter, "post", "/", { user: { id: "u", role: "coordinator" } })).status).toBe(401);
  });

  it.each([[undefined], [null], [""], ["abc"], [0], [-1], [1.5], ["01"], ["7.5"], [true]])("400s the event id %j", async (eventId) => {
    useDb(createFakeDb(seed()));
    const res = await post({ eventId, items: good.items });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "A valid eventId is required" });
  });

  it("400s a request with no body", async () => {
    useDb(createFakeDb(seed()));
    const out = await callRoute(equipmentRequestsRouter, "post", "/", { supabase: createFakeDb(), user: { id: "COORD-1", role: "coordinator" }, body: undefined });
    expect(out).toEqual({ status: 400, body: { error: "A valid eventId is required" } });
  });

  it("400s invalid items, naming the fields", async () => {
    useDb(createFakeDb(seed()));
    const res = await post({ eventId: 7, items: [{ equipmentCatalogId: 1, quantity: 0 }] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Validation failed", fields: { "items[0].quantity": "Quantity must be greater than zero." } });
  });

  it("400s catalog entries that don't exist, per item, without writing", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await post({ eventId: 7, items: [{ equipmentCatalogId: 1, quantity: 1 }, { equipmentCatalogId: 99, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Validation failed", fields: { "items[1].equipmentCatalogId": "Select a valid equipment type." } });
    expect(db.writes("equipment_requests")).toHaveLength(0);
  });

  it("500s when the catalog can't be read", async () => {
    const db = useDb(createFakeDb(seed()));
    db.failOn("equipment_catalog", "select");
    const res = await post(good);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to validate the equipment items" });
  });

  it("treats an empty catalog read as no such entries", async () => {
    const db = useDb(createFakeDb(seed()));
    db.nullOn("equipment_catalog", "select");
    expect((await post(good)).status).toBe(400);
  });

  it("404s an event the caller can't see, 502s when events-service fails", async () => {
    useDb(createFakeDb(seed()));
    world.eventDetail.set(7, { status: 403 });
    let res = await post(good);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event not found" });

    world.eventDetail.set(7, { status: 500 });
    res = await post(good);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the event" });
  });

  it("403s a coordinator who isn't assigned to the event", async () => {
    world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { coordinator_id: "COORD-2" }) } });
    const db = useDb(createFakeDb(seed()));
    const res = await post(good);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only the assigned coordinator can record equipment requirements" });
    expect(db.writes("equipment_requests")).toHaveLength(0);
  });

  it.each(["Draft", "Unassigned", "Requested", "Clarification Requested", "Safety Review", "Confirmed", "Rejected", "Completed", "Cancelled"])(
    "409s an event in %s",
    async (status) => {
      world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { status }) } });
      const db = useDb(createFakeDb(seed()));
      const res = await post(good);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "Equipment requirements can only be recorded while the event is in Planning or Needs Review." });
      expect(db.writes("equipment_requests")).toHaveLength(0);
    },
  );

  it("500s when the request can't be saved", async () => {
    const db = useDb(createFakeDb(seed()));
    db.failOn("equipment_requests", "insert");
    const res = await post(good);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to record the equipment request" });

    db.clearFailures();
    db.nullOn("equipment_requests", "insert");
    expect((await post(good)).status).toBe(500);
    expect(publisher.published).toHaveLength(0);
  });

  it("removes the request again when its items can't be saved, and tells nobody", async () => {
    const db = useDb(withDefaults(createFakeDb(seed())));
    db.failOn("equipment_request_items", "insert");
    let res = await post(good);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to record the equipment items" });
    expect(db.rows("equipment_requests")).toHaveLength(0);
    expect(publisher.published).toHaveLength(0);

    db.clearFailures();
    db.nullOn("equipment_request_items", "insert");
    res = await post(good);
    expect(res.status).toBe(500);
  });
});

describe("GET / for a coordinator, organiser or safety officer", () => {
  const get = (query: Record<string, string>, token = COORD) => request(app()).get("/api/equipment-requests").query(query).set("Authorization", token);

  beforeEach(() => world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7) } }));

  it.each([["coordinator", COORD], ["organiser", ORG], ["safety officer", SAFETY]])("shows one event's requests to a %s", async (_n, token) => {
    useDb(createFakeDb(seed({
      equipment_requests: [requestRow(1, 7, { status: "Arranged", fulfillment_note: "all done" }), requestRow(2, 8)],
      equipment_request_items: [itemRow(1, 1, { quantity_fulfilled: 2 }), itemRow(2, 1, { equipment_type: "Microphone", equipment_catalog_id: null, quantity_fulfilled: undefined }), itemRow(3, 2)],
    })));
    const res = await get({ eventId: "7" }, token);
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests).toEqual([
      {
        id: 1, eventId: 7, status: "Arranged", fulfillmentNote: "all done", createdAt: "2026-10-01T00:00:00.000Z",
        items: [
          { id: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 2, reservationFlag: { flagged: false, reason: null }, reservedUnits: [] },
          { id: 2, equipmentCatalogId: null, equipmentType: "Microphone", quantity: 2, quantityFulfilled: 0, reservationFlag: { flagged: false, reason: null }, reservedUnits: [] },
        ],
      },
    ]);
  });

  it("flags an item whose event now clashes with another event's claim on its unit", async () => {
    world.info = [infoEvent(8, { startTime: "11:00", endTime: "13:00" })];
    useDb(createFakeDb(seed({
      equipment_requests: [requestRow(1, 7)],
      equipment_request_items: [itemRow(1, 1)],
      equipment_booking: [
        { id: 1, equipment_id: 10, event_id: 7, request_item_id: 1, status: "Reserved" },
        { id: 2, equipment_id: 10, event_id: 8, request_item_id: 50, status: "Reserved" },
      ],
    })));
    const res = await get({ eventId: "7" });
    expect(res.body.equipmentRequests[0].items[0].reservationFlag).toEqual({
      flagged: true,
      reason: "This event's schedule now conflicts with another event's claim on the same reserved equipment unit.",
    });
  });

  it("shows an event with no requests as an empty list, without reading items", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await get({ eventId: "7" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ equipmentRequests: [] });
    expect(db.calls.some((c) => c.table === "equipment_request_items")).toBe(false);
  });

  it("copes with an event that has no details or no usable date", async () => {
    useDb(createFakeDb(seed({ equipment_requests: [requestRow(1, 7)], equipment_request_items: [itemRow(1, 1)] })));
    world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { submitted_details: null }) } });
    expect((await get({ eventId: "7" })).status).toBe(200);
    world.eventDetail.set(7, { status: 200, body: { event: detailEvent(7, { submitted_details: { name: "x" } }) } });
    expect((await get({ eventId: "7" })).status).toBe(200);
  });

  it.each([[{}], [{ eventId: "" }], [{ eventId: "abc" }], [{ eventId: "0" }], [{ eventId: "-1" }]])("400s the query %j", async (query) => {
    useDb(createFakeDb(seed()));
    const res = await get(query as Record<string, string>);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "A valid eventId is required" });
  });

  it("400s a repeated eventId parameter", async () => {
    useDb(createFakeDb(seed()));
    const res = await request(app()).get("/api/equipment-requests?eventId=7&eventId=8").set("Authorization", COORD);
    expect(res.status).toBe(400);
  });

  it("404s an event the caller can't see, 502s when events-service fails", async () => {
    useDb(createFakeDb(seed()));
    world.eventDetail.set(7, { status: 404 });
    let res = await get({ eventId: "7" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event not found" });

    world.eventDetail.set(7, { status: 500 });
    res = await get({ eventId: "7" });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the event" });
  });

  it("500s when the requests or the items can't be read", async () => {
    const requests = useDb(createFakeDb(seed()));
    requests.failOn("equipment_requests", "select");
    let res = await get({ eventId: "7" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment requests" });

    const none = useDb(createFakeDb(seed()));
    none.nullOn("equipment_requests", "select");
    expect((await get({ eventId: "7" })).status).toBe(500);

    const items = useDb(createFakeDb(seed({ equipment_requests: [requestRow(1, 7)] })));
    items.failOn("equipment_request_items", "select");
    res = await get({ eventId: "7" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment items" });
  });

  it("treats an empty read of the items as none", async () => {
    const db = useDb(createFakeDb(seed({ equipment_requests: [requestRow(1, 7)] })));
    db.nullOn("equipment_request_items", "select");
    const res = await get({ eventId: "7" });
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests[0].items).toEqual([]);
  });

  it("403s a role that has no business here", async () => {
    useDb(createFakeDb(seed()));
    const res = await get({ eventId: "7" }, ATTENDEE);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Access denied" });
  });

  it("401s without a client or user", async () => {
    expect(await callRoute(equipmentRequestsRouter, "get", "/", {})).toEqual({ status: 401, body: { error: "Unauthenticated" } });
    expect((await callRoute(equipmentRequestsRouter, "get", "/", { supabase: {} })).status).toBe(401);
    expect((await callRoute(equipmentRequestsRouter, "get", "/", { user: { id: "u", role: "coordinator" } })).status).toBe(401);
  });
});

describe("GET / for Technical Support", () => {
  const get = () => request(app()).get("/api/equipment-requests").set("Authorization", TS);

  it("lists every request newest first, cancelled ones included, with the event's whitelisted details", async () => {
    world.info = [infoEvent(7, { coordinatorId: "secret", equipment: "secret notes" }), infoEvent(8)];
    // The venue is the booked one (venue-service), never the organiser's "Indoor room for 60".
    world.bookedVenues = [{ eventId: 7, venueName: "Hall A" }];
    useDb(createFakeDb(seed({
      equipment_requests: [requestRow(1, 7), requestRow(2, 8, { status: "Cancelled" }), requestRow(3, 9)],
      equipment_request_items: [itemRow(1, 1), itemRow(2, 2), itemRow(3, 3)],
    })));
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests.map((r: any) => [r.id, r.status])).toEqual([[3, "Requested"], [2, "Cancelled"], [1, "Requested"]]);
    expect(res.body.equipmentRequests[2].event).toEqual({ id: 7, name: "E7", proposedDate: "2026-12-01", startTime: "10:00", endTime: "12:00", venue: "Hall A" });
    expect(res.body.equipmentRequests[0].event).toBeNull(); // events-service didn't return event 9
    expect(res.body.equipmentRequests[2].items).toHaveLength(1);
    expect(world.urls).toContain("GET /api/events/venue-booking-info?ids=9,8,7");
  });

  it("still lists the requests, without event details, when events-service can't be asked", async () => {
    world.infoOk = false;
    useDb(createFakeDb(seed({ equipment_requests: [requestRow(1, 7)], equipment_request_items: [itemRow(1, 1)] })));
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests[0].event).toBeNull();
  });

  it("flags a clash using the batched event windows", async () => {
    world.info = [infoEvent(7), infoEvent(8, { startTime: "11:00", endTime: "13:00" })];
    useDb(createFakeDb(seed({
      equipment_requests: [requestRow(1, 7), requestRow(2, 8)],
      equipment_request_items: [itemRow(1, 1), itemRow(2, 2)],
      equipment_booking: [
        { id: 1, equipment_id: 10, event_id: 7, request_item_id: 1, status: "Reserved" },
        { id: 2, equipment_id: 10, event_id: 8, request_item_id: 2, status: "Reserved" },
      ],
    })));
    const res = await get();
    const flagged = res.body.equipmentRequests.flatMap((r: any) => r.items).filter((i: any) => i.reservationFlag.flagged);
    expect(flagged.map((i: any) => i.id).sort()).toEqual([1, 2]);
  });

  it("is an empty list, reading no items, when nothing was requested", async () => {
    const db = useDb(createFakeDb(seed()));
    const res = await get();
    expect(res.body).toEqual({ equipmentRequests: [] });
    expect(db.calls.some((c) => c.table === "equipment_request_items")).toBe(false);
  });

  it("an event with no usable date contributes no window", async () => {
    world.info = [infoEvent(7, { proposedDate: null })];
    useDb(createFakeDb(seed({ equipment_requests: [requestRow(1, 7)], equipment_request_items: [itemRow(1, 1)] })));
    expect((await get()).status).toBe(200);
  });

  it("500s when the requests or the items can't be read", async () => {
    const requests = useDb(createFakeDb(seed()));
    requests.failOn("equipment_requests", "select");
    let res = await get();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment requests" });

    const none = useDb(createFakeDb(seed()));
    none.nullOn("equipment_requests", "select");
    expect((await get()).status).toBe(500);

    const items = useDb(createFakeDb(seed({ equipment_requests: [requestRow(1, 7)] })));
    items.failOn("equipment_request_items", "select");
    res = await get();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment items" });
  });

  it("treats an empty read of the items as none", async () => {
    const db = useDb(createFakeDb(seed({ equipment_requests: [requestRow(1, 7)] })));
    db.nullOn("equipment_request_items", "select");
    expect((await get()).body.equipmentRequests[0].items).toEqual([]);
  });
});

describe("GET /event/:eventId", () => {
  const get = (id: string, token = TS) => request(app()).get(`/api/equipment-requests/event/${id}`).set("Authorization", token);
  const full = () => seed({
    equipment_requests: [requestRow(1, 7, { created_at: "2026-10-02T00:00:00.000Z" }), requestRow(2, 7, { coordinator_id: null, created_at: "2026-10-01T00:00:00.000Z" }), requestRow(3, 8)],
    equipment_request_items: [itemRow(1, 1), itemRow(2, 2), itemRow(3, 3)],
  });

  beforeEach(() => {
    world.info = [infoEvent(7, { technicalSupport: "  needs a clicker  " })];
    world.bookedVenues = [{ eventId: 7, venueName: "Hall A" }];
    world.names = [{ id: "COORD-1", name: "Ann" }];
  });

  it("shows the event, the organiser's technical notes and each request with who raised it, oldest first", async () => {
    useDb(createFakeDb(full()));
    const res = await get("7");
    expect(res.status).toBe(200);
    expect(res.body.event).toEqual({ id: 7, name: "E7", proposedDate: "2026-12-01", startTime: "10:00", endTime: "12:00", venue: "Hall A" });
    expect(res.body.technicalRequirements).toBe("needs a clicker");
    expect(res.body.equipmentRequests.map((r: any) => [r.id, r.requestedBy])).toEqual([[2, null], [1, { id: "COORD-1", name: "Ann" }]]);
    expect(world.urls).toContain("GET /api/users/names?ids=COORD-1");
  });

  it("has null technical requirements when the notes are missing or blank", async () => {
    useDb(createFakeDb(full()));
    for (const technicalSupport of [null, undefined, "   "]) {
      world.info = [infoEvent(7, { technicalSupport })];
      expect((await get("7")).body.technicalRequirements).toBeNull();
    }
  });

  it("falls back to a null name when user-service can't say", async () => {
    useDb(createFakeDb(full()));
    world.namesOk = false;
    const res = await get("7");
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests.find((r: any) => r.id === 1).requestedBy).toEqual({ id: "COORD-1", name: null });
  });

  it("does not ask user-service when no request names a coordinator", async () => {
    useDb(createFakeDb(seed({ equipment_requests: [requestRow(1, 7, { coordinator_id: null })], equipment_request_items: [itemRow(1, 1)] })));
    await get("7");
    expect(world.urls.some((u) => u.includes("/api/users/names"))).toBe(false);
  });

  it("shows which units are reserved for each item, labelled", async () => {
    const data = full();
    useDb(createFakeDb({
      ...data,
      equipment: [{ id: 10, label: "Sticker 1" }, { id: 11, label: null }],
      equipment_booking: [
        { id: 1, equipment_id: 10, event_id: 7, request_item_id: 1, status: "Reserved" },
        { id: 2, equipment_id: 11, event_id: 7, request_item_id: 1, status: "Reserved" },
        { id: 3, equipment_id: 12, event_id: 7, request_item_id: 1, status: "Reserved" }, // unit row missing: no label
        { id: 4, equipment_id: 10, event_id: 7, request_item_id: null, status: "Reserved" }, // not tied to an item
        { id: 5, equipment_id: 10, event_id: 7, request_item_id: 1, status: "Released" },
      ],
    }));
    const res = await get("7");
    const item = res.body.equipmentRequests.find((r: any) => r.id === 1).items[0];
    expect(item.reservedUnits).toEqual([{ id: 10, label: "Sticker 1" }, { id: 11, label: null }, { id: 12, label: null }]);
  });

  it("shows no reserved units when the bookings or the unit labels can't be read", async () => {
    const bookings = useDb(createFakeDb({ ...full(), equipment_booking: [{ id: 1, equipment_id: 10, event_id: 7, request_item_id: 1, status: "Reserved" }] }));
    bookings.failOn("equipment_booking", "select", -1, (c) => c.columns === "equipment_id, request_item_id");
    expect((await get("7")).body.equipmentRequests[1].items[0].reservedUnits).toEqual([]);

    const units = useDb(createFakeDb({ ...full(), equipment: [{ id: 10, label: "S" }], equipment_booking: [{ id: 1, equipment_id: 10, event_id: 7, request_item_id: 1, status: "Reserved" }] }));
    units.failOn("equipment", "select");
    expect((await get("7")).body.equipmentRequests[1].items[0].reservedUnits).toEqual([]);

    const empty = useDb(createFakeDb({ ...full(), equipment_booking: [{ id: 1, equipment_id: 10, event_id: 7, request_item_id: 1, status: "Reserved" }] }));
    empty.nullOn("equipment_booking", "select", -1, (c) => c.columns === "equipment_id, request_item_id");
    expect((await get("7")).status).toBe(200);

    const noUnitRows = useDb(createFakeDb({ ...full(), equipment_booking: [{ id: 1, equipment_id: 10, event_id: 7, request_item_id: 1, status: "Reserved" }] }));
    noUnitRows.nullOn("equipment", "select");
    expect((await get("7")).body.equipmentRequests[1].items[0].reservedUnits).toEqual([{ id: 10, label: null }]);
  });

  it("ignores a booking row that isn't tied to an item, should the driver return one", async () => {
    const db = useDb(createFakeDb({ ...full(), equipment: [{ id: 10, label: "S" }], equipment_booking: [{ id: 1, equipment_id: 10, event_id: 7, request_item_id: 1, status: "Reserved" }] }));
    db.mapOn("equipment_booking", "select", (r) => ({ ...r, data: r.data && [...r.data, { equipment_id: 10, request_item_id: null }] }));
    const res = await get("7");
    expect(res.status).toBe(200);
    expect(res.body.equipmentRequests.find((r: any) => r.id === 1).items[0].reservedUnits).toEqual([{ id: 10, label: "S" }]);
    expect(res.body.equipmentRequests.find((r: any) => r.id === 2).items[0].reservedUnits).toEqual([]);
  });

  it("403s anyone but Technical Support, and a malformed or unknown event id", async () => {
    useDb(createFakeDb(full()));
    expect((await get("7", COORD)).status).toBe(403);
    for (const id of ["abc", "0", "-1"]) {
      const res = await get(id);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "Access denied" });
    }
    expect((await get("99")).status).toBe(403); // nothing requested for it
  });

  it("403s an event events-service doesn't return", async () => {
    useDb(createFakeDb(full()));
    world.info = [];
    expect((await get("7")).status).toBe(403);
  });

  it("502s when events-service can't be asked", async () => {
    useDb(createFakeDb(full()));
    world.infoOk = false;
    const res = await get("7");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the event" });
  });

  it("500s when the requests or the items can't be read", async () => {
    const requests = useDb(createFakeDb(full()));
    requests.failOn("equipment_requests", "select");
    let res = await get("7");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment requests" });

    const none = useDb(createFakeDb(full()));
    none.nullOn("equipment_requests", "select");
    expect((await get("7")).status).toBe(500);

    const items = useDb(createFakeDb(full()));
    items.failOn("equipment_request_items", "select");
    res = await get("7");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment items" });
  });

  it("treats an empty read of the items as none", async () => {
    const db = useDb(createFakeDb(full()));
    db.nullOn("equipment_request_items", "select");
    expect((await get("7")).body.equipmentRequests[0].items).toEqual([]);
  });

  it("copes with an event that has no usable date", async () => {
    world.info = [infoEvent(7, { proposedDate: null })];
    useDb(createFakeDb(full()));
    expect((await get("7")).status).toBe(200);
  });

  it("reads an array event id by its first element, and 401s without a user", async () => {
    const db = useDb(createFakeDb(full()));
    const out = await callRoute(equipmentRequestsRouter, "get", "/event/:eventId", {
      supabase: db, user: { id: "TS-1", role: "technical_support" }, params: { eventId: ["7", "8"] }, headers: { authorization: "Bearer x" },
    });
    expect(out.status).toBe(200);
    expect(await callRoute(equipmentRequestsRouter, "get", "/event/:eventId", { params: { eventId: "7" } })).toEqual({
      status: 401, body: { error: "Unauthenticated" },
    });
  });
});

describe("GET /items/:itemId/unit-preview", () => {
  const get = (id: string, quantity?: string, token = TS) =>
    request(app()).get(`/api/equipment-requests/items/${id}/unit-preview`).query(quantity === undefined ? {} : { quantity }).set("Authorization", token);
  const world1 = () => seed({
    equipment_requests: [requestRow(1, 7)],
    equipment_request_items: [itemRow(1, 1, { quantity: 3 })],
    equipment: [
      { id: 10, status: "Available", equipment_catalog_id: 1, label: "S-10" },
      { id: 11, status: "Available", equipment_catalog_id: 1, label: null },
      { id: 12, status: "Available", equipment_catalog_id: 1, label: null },
    ],
  });

  beforeEach(() => {
    world.info = [infoEvent(7)];
  });

  it("previews the units a claim would take, labelled, nothing written", async () => {
    const db = useDb(createFakeDb(world1()));
    const res = await get("1", "2");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      claimedIds: [10, 11],
      units: [{ id: 10, label: "S-10" }, { id: 11, label: null }],
      availableCount: 3,
      shortfall: 0,
    });
    expect(db.calls.filter((c) => c.op !== "select")).toHaveLength(0);
  });

  it("reports a shortfall, and previews no units when none are free", async () => {
    const some = useDb(createFakeDb(world1()));
    let res = await get("1", "5");
    expect(res.body).toMatchObject({ claimedIds: [10, 11, 12], availableCount: 3, shortfall: 2 });

    const none = useDb(createFakeDb({ ...world1(), equipment: [] }));
    res = await get("1", "2");
    expect(res.body).toEqual({ claimedIds: [], units: [], availableCount: 0, shortfall: 2 });
    expect(some.calls.length).toBeGreaterThan(0);
    expect(none.calls.some((c) => c.table === "equipment" && c.columns === "id, label")).toBe(false);
  });

  it("only previews what an item doesn't already hold", async () => {
    useDb(createFakeDb({ ...world1(), equipment_request_items: [itemRow(1, 1, { quantity: 3, quantity_fulfilled: 1 })] }));
    const res = await get("1", "2");
    expect(res.body.claimedIds).toHaveLength(1);
  });

  it("is empty for a quantity the item already holds, or zero, without asking events-service", async () => {
    useDb(createFakeDb({ ...world1(), equipment_request_items: [itemRow(1, 1, { quantity: 3, quantity_fulfilled: 2 })] }));
    for (const q of ["2", "1", "0"]) {
      const res = await get("1", q);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ claimedIds: [], units: [], availableCount: 0, shortfall: 0 });
    }
    expect(world.urls).toHaveLength(0);
  });

  it("treats an item with no fulfilled count as holding none", async () => {
    useDb(createFakeDb({ ...world1(), equipment_request_items: [itemRow(1, 1, { quantity: 3, quantity_fulfilled: null })] }));
    expect((await get("1", "1")).body.claimedIds).toHaveLength(1);
  });

  it("403s anyone but Technical Support, and 401s without a user", async () => {
    useDb(createFakeDb(world1()));
    const res = await get("1", "1", COORD);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Only Technical Support can preview equipment units" });
    expect(await callRoute(equipmentRequestsRouter, "get", "/items/:itemId/unit-preview", {})).toEqual({ status: 401, body: { error: "Unauthenticated" } });
    expect((await callRoute(equipmentRequestsRouter, "get", "/items/:itemId/unit-preview", { supabase: {} })).status).toBe(401);
  });

  it.each(["0", "abc", "-1", "01"])("400s the item id %s", async (id) => {
    useDb(createFakeDb(world1()));
    const res = await get(id, "1");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "A valid item id is required" });
  });

  it.each([[undefined], [""], ["abc"], ["-1"], ["1.5"], ["01"]])("400s the quantity %j", async (quantity) => {
    useDb(createFakeDb(world1()));
    const res = await get("1", quantity);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "A valid quantity is required" });
  });

  it("400s a repeated quantity parameter", async () => {
    useDb(createFakeDb(world1()));
    const res = await request(app()).get("/api/equipment-requests/items/1/unit-preview?quantity=1&quantity=2").set("Authorization", TS);
    expect(res.status).toBe(400);
  });

  it("500s when the item can't be read, 404s one that doesn't exist, 409s one with no catalog link", async () => {
    const failing = useDb(createFakeDb(world1()));
    failing.failOn("equipment_request_items", "select");
    let res = await get("1", "1");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load the equipment item" });

    useDb(createFakeDb(world1()));
    res = await get("99", "1");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Equipment item not found" });

    useDb(createFakeDb({ ...world1(), equipment_request_items: [itemRow(1, 1, { equipment_catalog_id: null, equipment_type: "Cable" })] }));
    res = await get("1", "1");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Cable isn't linked to an equipment catalog item, so it can't be previewed." });
  });

  it("404s when the item's request can't be found or read", async () => {
    useDb(createFakeDb({ ...world1(), equipment_requests: [] }));
    const res = await get("1", "1");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Equipment request not found" });

    const failing = useDb(createFakeDb(world1()));
    failing.failOn("equipment_requests", "select");
    expect((await get("1", "1")).status).toBe(404);
  });

  it("502s, 404s or 409s according to what events-service says about the event", async () => {
    useDb(createFakeDb(world1()));
    world.infoOk = false;
    let res = await get("1", "1");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Failed to load the event" });

    world.infoOk = true;
    world.info = [];
    res = await get("1", "1");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Event not found" });

    world.info = [infoEvent(7, { proposedDate: null })];
    res = await get("1", "1");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "This event has no date or time set yet, so availability can't be checked." });
  });

  it("500s when availability can't be worked out, or the unit labels can't be read", async () => {
    const units = useDb(createFakeDb(world1()));
    units.failOn("equipment", "select", -1, (c) => c.columns === "id, status");
    let res = await get("1", "1");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to check equipment availability" });

    const labels = useDb(createFakeDb(world1()));
    labels.failOn("equipment", "select", -1, (c) => c.columns === "id, label");
    res = await get("1", "1");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Failed to load equipment units" });
  });

  it("previews unlabelled units when the label read comes back empty", async () => {
    const db = useDb(createFakeDb(world1()));
    db.nullOn("equipment", "select", -1, (c) => c.columns === "id, label");
    const res = await get("1", "1");
    expect(res.status).toBe(200);
    expect(res.body.units).toEqual([]);
  });
});
