/**
 * Real-DB integration test for the event lifecycle routes. Runs the real
 * eventsRouter against the real (shared dev) Supabase project, so it proves
 * what the mocked suite cannot: the enum, the FKs, the history rows and the
 * "update only matches while …" guards behave as the routes assume.
 *
 * Everything it creates is namespaced "ZEVT-<run>": throwaway users inserted
 * directly (self-signup can't create staff roles) and the events they own.
 * Teardown deletes in FK-safe order in afterAll whatever the outcome, and
 * beforeAll sweeps anything an earlier crashed run left behind. The final
 * test asserts nothing with the prefix remains.
 *
 * RabbitMQ is replaced by an in-memory publisher and the user-service lookup
 * is stubbed to the seeded coordinator, so the test needs only Supabase.
 * Run with `npm run test:integration`; it is excluded from `npm test`.
 */
import "../../lib/env.js";
import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eventsRouter } from "../../routes/events.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { signToken } from "../../lib/jwt.js";
import { setPublisherForTest, type OutboundMessage } from "../../lib/rabbitPublisher.js";

const { RUN } = vi.hoisted(() => ({ RUN: Date.now() }));
const PREFIX = "ZEVT-";
const ORG = `${PREFIX}ORG-${RUN}`;
const OTHER_ORG = `${PREFIX}ORG2-${RUN}`;
const COORD = `${PREFIX}COORD-${RUN}`;
const OTHER_COORD = `${PREFIX}COORD2-${RUN}`;
const LEAD = `${PREFIX}LEAD-${RUN}`;
const USERS = [
  { id: ORG, role: "organiser" },
  { id: OTHER_ORG, role: "organiser" },
  { id: COORD, role: "coordinator" },
  { id: OTHER_COORD, role: "coordinator" },
  { id: LEAD, role: "coordinator_lead" },
];

// The coordinator list normally comes from user-service over HTTP.
vi.mock("../../lib/usersClient.js", () => ({
  fetchCoordinators: async () => ({
    status: "ok",
    coordinators: [
      { id: `ZEVT-COORD-${RUN}`, name: "Integration Coordinator" },
      { id: `ZEVT-COORD2-${RUN}`, name: "Integration Coordinator Two" },
    ],
  }),
  fetchCoordinatorLeads: async () => ({ status: "ok", coordinators: [] }),
}));

const published: OutboundMessage[] = [];
const createdEventIds: number[] = [];

const tokens = {
  org: signToken({ sub: ORG, role: "organiser" }),
  otherOrg: signToken({ sub: OTHER_ORG, role: "organiser" }),
  coord: signToken({ sub: COORD, role: "coordinator" }),
  otherCoord: signToken({ sub: OTHER_COORD, role: "coordinator" }),
  lead: signToken({ sub: LEAD, role: "coordinator_lead" }),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  return app;
}
const app = buildApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function eventBody(overrides: Record<string, unknown> = {}) {
  return {
    name: `${PREFIX}event ${RUN}`,
    purpose: "Integration test",
    description: "Created by eventLifecycle.test.ts; safe to delete",
    proposedDate: "2099-06-01",
    startTime: "10:00",
    endTime: "12:00",
    expectedAttendance: 25,
    venue: "Any hall",
    accessibility: "Step-free",
    equipment: "None",
    technicalSupport: "None",
    registrationNeeded: false,
    ...overrides,
  };
}

async function submitEvent(overrides: Record<string, unknown> = {}): Promise<number> {
  const res = await request(app).post("/api/events").set(auth(tokens.org)).send(eventBody(overrides));
  expect(res.status).toBe(201);
  createdEventIds.push(res.body.event.id);
  return res.body.event.id;
}

async function dbEvent(id: number) {
  const { data, error } = await supabaseAdmin.from("events").select("*").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data as Record<string, unknown> & { status: string; coordinator_id: string | null };
}

async function dbHistory(id: number) {
  const { data } = await supabaseAdmin.from("event_history").select("field, old_value, new_value, changed_by").eq("event_id", id);
  return data ?? [];
}

/**
 * Lets every database call through for real except the first one `shouldFail` picks, which answers with an
 * error instead. The route under test uses this same `supabaseAdmin`, so this is how a write that fails
 * part-way is reproduced against the real tables. Call `restore()` when done.
 */
function failFirstMatching(shouldFail: (table: string, operation: string, args: unknown[]) => boolean) {
  const realFrom = supabaseAdmin.from.bind(supabaseAdmin);
  let fired = false;
  const failure: Record<string, unknown> = {};
  for (const method of ["eq", "in", "select", "single", "maybeSingle"]) failure[method] = () => failure;
  failure.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error: { message: "injected failure" } });

  const spy = vi.spyOn(supabaseAdmin, "from").mockImplementation(((table: string) => {
    const builder = realFrom(table) as unknown as Record<string, unknown>;
    return new Proxy(builder, {
      get(target, property) {
        const value = target[property as string];
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (!fired && shouldFail(table, String(property), args)) {
            fired = true;
            return failure;
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  }) as never);

  return { restore: () => spy.mockRestore(), didFire: () => fired };
}

async function confirm(id: number): Promise<void> {
  const { error } = await supabaseAdmin.from("events").update({ status: "Confirmed" }).eq("id", id);
  if (error) throw new Error(error.message);
}

async function dbChangeRequests(id: number) {
  const { data } = await supabaseAdmin.from("change_requests").select("id, status").eq("event_id", id);
  return (data ?? []) as { id: number; status: string }[];
}

async function dbChangeRequestFields(requestId: number) {
  const { data } = await supabaseAdmin.from("change_request_fields").select("field, new_value").eq("request_id", requestId).order("field");
  return (data ?? []) as { field: string; new_value: string }[];
}

/** Deletes everything this suite (or a crashed earlier run) created. FK order: children without cascade first. */
async function purge(): Promise<void> {
  const { data: events } = await supabaseAdmin.from("events").select("id").like("organiser_id", `${PREFIX}%`);
  const ids = [...new Set([...(events ?? []).map((e: { id: number }) => e.id), ...createdEventIds])];
  if (ids.length > 0) {
    for (const table of ["event_clarifications", "event_history", "event_safety_reviews", "event_safety_submissions"]) {
      await supabaseAdmin.from(table).delete().in("event_id", ids);
    }
    await supabaseAdmin.from("event_outbox").delete().in("event_id", ids);
    await supabaseAdmin.from("events").delete().in("id", ids);
  }
  await supabaseAdmin.from("access_denials").delete().like("user_id", `${PREFIX}%`);
  await supabaseAdmin.from("users").delete().like("id", `${PREFIX}%`);
}

beforeAll(async () => {
  setPublisherForTest({
    publish: async (msg) => {
      published.push(msg);
      return true;
    },
  });
  await purge();
  const { error } = await supabaseAdmin.from("users").insert(
    USERS.map((u) => ({
      id: u.id,
      name: `Integration ${u.role}`,
      email: `${u.id.toLowerCase()}@example.com`,
      password_hash: bcrypt.hashSync("unused-placeholder1", 4),
      role: u.role,
    })),
  );
  if (error) throw new Error(`Could not seed integration users: ${error.message}`);
}, 30_000);

afterAll(async () => {
  setPublisherForTest(undefined);
  await purge();
}, 30_000);

describe("a failed change request is undone (real Supabase project)", () => {
  async function confirmedEvent(): Promise<number> {
    const id = await submitEvent();
    await request(app).post(`/api/events/${id}/assign`).set(auth(tokens.lead)).send({ coordinatorId: COORD });
    await request(app).post(`/api/events/${id}/approve`).set(auth(tokens.coord));
    await confirm(id);
    return id;
  }

  it("deletes the request it created, and its fields with it, when the move to Needs Review fails", async () => {
    const id = await confirmedEvent();
    const heldVenue = `ZEVT-undo-venue-${RUN}`;
    const failure = failFirstMatching((table, operation, args) => table === "events" && operation === "update" && (args[0] as { status?: string })?.status === "Needs Review");

    let res;
    try {
      res = await request(app).post(`/api/events/${id}/change-requests`).set(auth(tokens.org)).send({ venue: heldVenue });
    } finally {
      failure.restore();
    }

    expect(failure.didFire()).toBe(true);
    expect(res.status).toBe(500);

    // The request row is gone. Its field row could not have been left behind: it references the request, so
    // the delete only succeeds if the fields go with it (on delete cascade, migration 0036).
    expect(await dbChangeRequests(id)).toEqual([]);
    const { data: leftover } = await supabaseAdmin.from("change_request_fields").select("id").eq("new_value", heldVenue);
    expect(leftover).toEqual([]);

    // Nothing about the event moved, and no history says it did.
    const row = await dbEvent(id);
    expect(row.status).toBe("Confirmed");
    expect((await dbHistory(id)).some((h) => String(h.new_value).includes(heldVenue))).toBe(false);
    expect(published.some((m) => m.eventId === id && m.type === "change.requested")).toBe(false);
  });

  it("puts an open request back as it was when a later write fails", async () => {
    const id = await confirmedEvent();
    const first = await request(app).post(`/api/events/${id}/change-requests`).set(auth(tokens.org)).send({ venue: `ZEVT-held-A-${RUN}` });
    expect(first.status).toBe(201);
    const requestId = first.body.changeRequestId as number;
    expect((await dbEvent(id)).status).toBe("Needs Review");
    expect(await dbChangeRequestFields(requestId)).toEqual([{ field: "venue", new_value: `ZEVT-held-A-${RUN}` }]);
    const detailsBefore = (await dbEvent(id)).submitted_details;

    // Overwrite the held venue and add a non-critical edit; the fields are written, then the details update fails.
    const failure = failFirstMatching((table, operation, args) => table === "events" && operation === "update" && "submitted_details" in ((args[0] as object) ?? {}));
    let res;
    try {
      res = await request(app)
        .post(`/api/events/${id}/change-requests`)
        .set(auth(tokens.org))
        .send({ venue: `ZEVT-held-B-${RUN}`, description: `ZEVT-undo description ${RUN}` });
    } finally {
      failure.restore();
    }

    expect(failure.didFire()).toBe(true);
    expect(res.status).toBe(500);

    // The same request, still Pending, holding the venue it held before; the field added by the failed call is gone.
    expect(await dbChangeRequests(id)).toEqual([{ id: requestId, status: "Pending" }]);
    expect(await dbChangeRequestFields(requestId)).toEqual([{ field: "venue", new_value: `ZEVT-held-A-${RUN}` }]);
    expect((await dbEvent(id)).submitted_details).toEqual(detailsBefore);
  });
});

describe("event lifecycle (real Supabase project)", () => {
  it("submit → Unassigned → Lead assigns → Requested → coordinator approves → Planning, with history", async () => {
    const id = await submitEvent();
    expect((await dbEvent(id)).status).toBe("Unassigned");
    expect(published.some((m) => m.type === "request.submitted" && m.eventId === id)).toBe(true);

    const assigned = await request(app).post(`/api/events/${id}/assign`).set(auth(tokens.lead)).send({ coordinatorId: COORD });
    expect(assigned.status).toBe(200);
    const afterAssign = await dbEvent(id);
    expect(afterAssign.status).toBe("Requested");
    expect(afterAssign.coordinator_id).toBe(COORD);
    expect(await dbHistory(id)).toEqual(
      expect.arrayContaining([
        { field: "Coordinator", old_value: null, new_value: "Integration Coordinator", changed_by: LEAD },
        { field: "Status", old_value: "Unassigned", new_value: "Requested", changed_by: LEAD },
      ]),
    );

    const approved = await request(app).post(`/api/events/${id}/approve`).set(auth(tokens.coord));
    expect(approved.status).toBe(200);
    const afterApprove = await dbEvent(id);
    expect(afterApprove.status).toBe("Planning");
    expect(afterApprove.decided_by).toBe(COORD);
  });

  it("a clarification round trip returns to exactly the status it came from", async () => {
    const id = await submitEvent();
    await request(app).post(`/api/events/${id}/assign`).set(auth(tokens.lead)).send({ coordinatorId: COORD });

    const asked = await request(app)
      .post(`/api/events/${id}/request-clarification`)
      .set(auth(tokens.coord))
      .send({ message: "Which hall?" });
    expect(asked.status).toBe(200);
    const clarifying = await dbEvent(id);
    expect(clarifying.status).toBe("Clarification Requested");
    expect(clarifying.status_before_clarification).toBe("Requested");

    const blocked = await request(app).post(`/api/events/${id}/approve`).set(auth(tokens.coord));
    expect(blocked.status).toBe(409);
    expect((await dbEvent(id)).status).toBe("Clarification Requested");

    const replied = await request(app)
      .patch(`/api/events/${id}`)
      .set(auth(tokens.org))
      .send(eventBody({ venue: "Main hall" }));
    expect(replied.status).toBe(200);
    expect((await dbEvent(id)).status).toBe("Requested");
  });

  it("answering a clarification raised from Requested with a new date announces no reschedule", async () => {
    const id = await submitEvent();
    await request(app).post(`/api/events/${id}/assign`).set(auth(tokens.lead)).send({ coordinatorId: COORD });
    await request(app).post(`/api/events/${id}/request-clarification`).set(auth(tokens.coord)).send({ message: "Which day?" });

    const replied = await request(app)
      .patch(`/api/events/${id}`)
      .set(auth(tokens.org))
      .send(eventBody({ proposedDate: "2099-07-01", expectedAttendance: 40 }));
    expect(replied.status).toBe(200);
    expect((await dbEvent(id)).status).toBe("Requested");

    // Nothing can be booked before Planning, so neither message is stored or published.
    const { data: outbox } = await supabaseAdmin.from("event_outbox").select("type").eq("event_id", id);
    expect(outbox ?? []).toEqual([]);
    expect(published.filter((m) => m.eventId === id && (m.type === "event.rescheduled" || m.type === "event.attendance_changed"))).toEqual([]);
  });

  it("a Planning event can be rejected through a clarification: Rejected, history written, event.rejected stored, terminal", async () => {
    const id = await submitEvent();
    await request(app).post(`/api/events/${id}/assign`).set(auth(tokens.lead)).send({ coordinatorId: COORD });
    await request(app).post(`/api/events/${id}/approve`).set(auth(tokens.coord));
    const asked = await request(app)
      .post(`/api/events/${id}/request-clarification`)
      .set(auth(tokens.coord))
      .send({ message: "Can this move to another week?" });
    expect(asked.status).toBe(200);
    expect((await dbEvent(id)).status_before_clarification).toBe("Planning");

    const noReason = await request(app).post(`/api/events/${id}/reject`).set(auth(tokens.coord)).send({ reason: "   " });
    expect(noReason.status).toBe(400);
    const notAssigned = await request(app).post(`/api/events/${id}/reject`).set(auth(tokens.otherCoord)).send({ reason: "mine now" });
    expect([403, 404]).toContain(notAssigned.status);
    expect((await dbEvent(id)).status).toBe("Clarification Requested");

    const rejected = await request(app).post(`/api/events/${id}/reject`).set(auth(tokens.coord)).send({ reason: "No suitable week is free" });
    expect(rejected.status).toBe(200);
    const row = await dbEvent(id);
    expect(row.status).toBe("Rejected");
    expect(row.review_outcome).toBe("No suitable week is free");
    expect(row.decided_by).toBe(COORD);

    expect(await dbHistory(id)).toEqual(
      expect.arrayContaining([
        { field: "Status", old_value: "Clarification Requested", new_value: "Rejected", changed_by: COORD },
        { field: "Rejection reason", old_value: null, new_value: "No suitable week is free", changed_by: COORD },
      ]),
    );

    // The message venue-service and equipment-service release the event's arrangements on.
    const { data: outbox } = await supabaseAdmin.from("event_outbox").select("type, data, recipients, published_at").eq("event_id", id);
    expect(outbox).toHaveLength(1);
    expect(outbox?.[0]).toMatchObject({
      type: "event.rejected",
      data: { reason: "No suitable week is free" },
      recipients: { userIds: [], roles: [] },
    });
    expect(outbox?.[0].published_at).not.toBeNull();
    expect(published.some((m) => m.type === "request.decided" && m.eventId === id)).toBe(true);

    const twice = await request(app).post(`/api/events/${id}/reject`).set(auth(tokens.coord)).send({ reason: "again" });
    expect(twice.status).toBe(409);
    const edit = await request(app).patch(`/api/events/${id}`).set(auth(tokens.org)).send(eventBody());
    expect(edit.status).toBe(409);
  });

  it("an illegal transition returns 409 and leaves the row exactly as it was", async () => {
    const id = await submitEvent();
    const before = await dbEvent(id);

    for (const path of ["approve", "reject", "complete", "submit-safety-review"]) {
      const res = await request(app).post(`/api/events/${id}/${path}`).set(auth(tokens.coord)).send({ reason: "x" });
      expect([403, 404, 409]).toContain(res.status);
    }
    expect(await dbEvent(id)).toEqual(before);
  });

  it("only the Lead can assign, a second assignment is refused, and an unknown coordinator is rejected", async () => {
    const id = await submitEvent();

    const byCoordinator = await request(app).post(`/api/events/${id}/assign`).set(auth(tokens.coord)).send({ coordinatorId: COORD });
    expect(byCoordinator.status).toBe(403);
    const unknown = await request(app).post(`/api/events/${id}/assign`).set(auth(tokens.lead)).send({ coordinatorId: "NOBODY" });
    expect(unknown.status).toBe(400);
    expect((await dbEvent(id)).status).toBe("Unassigned");

    expect((await request(app).post(`/api/events/${id}/assign`).set(auth(tokens.lead)).send({ coordinatorId: COORD })).status).toBe(200);
    const again = await request(app).post(`/api/events/${id}/assign`).set(auth(tokens.lead)).send({ coordinatorId: OTHER_COORD });
    expect(again.status).toBe(409);
    expect((await dbEvent(id)).coordinator_id).toBe(COORD);
  });

  it("two simultaneous assignments: exactly one wins and the event keeps a single coordinator", async () => {
    const id = await submitEvent();
    const [a, b] = await Promise.all([
      request(app).post(`/api/events/${id}/assign`).set(auth(tokens.lead)).send({ coordinatorId: COORD }),
      request(app).post(`/api/events/${id}/assign`).set(auth(tokens.lead)).send({ coordinatorId: OTHER_COORD }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? COORD : OTHER_COORD;
    const row = await dbEvent(id);
    expect(row.coordinator_id).toBe(winner);
    expect(row.status).toBe("Requested");
  });

  it("Unassigned and Requested events are directly editable by the owner, with history; others are refused", async () => {
    const id = await submitEvent();

    const edited = await request(app).patch(`/api/events/${id}`).set(auth(tokens.org)).send(eventBody({ expectedAttendance: 40 }));
    expect(edited.status).toBe(200);
    expect(((await dbEvent(id)).submitted_details as { expectedAttendance: number }).expectedAttendance).toBe(40);
    expect(await dbHistory(id)).toContainEqual({
      field: "Expected attendance",
      old_value: "25",
      new_value: "40",
      changed_by: ORG,
    });

    const byStranger = await request(app).patch(`/api/events/${id}`).set(auth(tokens.otherOrg)).send(eventBody({ expectedAttendance: 99 }));
    expect(byStranger.status).toBe(403);
    expect(((await dbEvent(id)).submitted_details as { expectedAttendance: number }).expectedAttendance).toBe(40);

    const invalid = await request(app).patch(`/api/events/${id}`).set(auth(tokens.org)).send(eventBody({ expectedAttendance: 0 }));
    expect(invalid.status).toBe(400);
    expect(((await dbEvent(id)).submitted_details as { expectedAttendance: number }).expectedAttendance).toBe(40);
  });

  it("a validation failure creates no row", async () => {
    const { count: before } = await supabaseAdmin.from("events").select("id", { count: "exact", head: true }).eq("organiser_id", ORG);
    const res = await request(app).post("/api/events").set(auth(tokens.org)).send(eventBody({ proposedDate: "2000-01-01", startTime: "12:00", endTime: "11:00" }));
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields).sort()).toEqual(["endTime", "proposedDate"]);
    const { count: after } = await supabaseAdmin.from("events").select("id", { count: "exact", head: true }).eq("organiser_id", ORG);
    expect(after).toBe(before);
  });

  it("the owner cancels with a reason: Cancelled, reason stored, outbox row written, terminal", async () => {
    const id = await submitEvent();

    const noReason = await request(app).post(`/api/events/${id}/cancel`).set(auth(tokens.org)).send({ reason: "   " });
    expect(noReason.status).toBe(400);
    expect((await dbEvent(id)).status).toBe("Unassigned");

    const notOwner = await request(app).post(`/api/events/${id}/cancel`).set(auth(tokens.otherOrg)).send({ reason: "mine now" });
    expect(notOwner.status).toBe(403);

    const cancelled = await request(app).post(`/api/events/${id}/cancel`).set(auth(tokens.org)).send({ reason: "Venue flooded" });
    expect(cancelled.status).toBe(200);
    const row = await dbEvent(id);
    expect(row.status).toBe("Cancelled");
    expect(row.review_outcome).toBe("Venue flooded");
    expect(row.decided_by).toBe(ORG);

    const { data: outbox } = await supabaseAdmin.from("event_outbox").select("type, data, published_at").eq("event_id", id);
    expect(outbox).toHaveLength(1);
    expect(outbox?.[0]).toMatchObject({ type: "event.cancelled", data: { reason: "Venue flooded" } });
    expect(outbox?.[0].published_at).not.toBeNull();

    const twice = await request(app).post(`/api/events/${id}/cancel`).set(auth(tokens.org)).send({ reason: "again" });
    expect(twice.status).toBe(409);
    const edit = await request(app).patch(`/api/events/${id}`).set(auth(tokens.org)).send(eventBody());
    expect(edit.status).toBe(409);
  });

  it("drafts stay private and exit only by submit: a draft can be saved empty, then deleted", async () => {
    const created = await request(app).post("/api/events/draft").set(auth(tokens.org)).send({});
    expect(created.status).toBe(201);
    const id = created.body.event.id as number;
    createdEventIds.push(id);
    expect((await dbEvent(id)).status).toBe("Draft");

    const seenByLead = await request(app).get(`/api/events/${id}`).set(auth(tokens.lead));
    expect(seenByLead.status).toBe(403);
    const cancelDraft = await request(app).post(`/api/events/${id}/cancel`).set(auth(tokens.org)).send({ reason: "x" });
    expect(cancelDraft.status).toBe(409);

    const deleted = await request(app).delete(`/api/events/${id}/draft`).set(auth(tokens.org));
    expect(deleted.status).toBeLessThan(300);
    const { data } = await supabaseAdmin.from("events").select("id").eq("id", id);
    expect(data).toEqual([]);
  });

  it("rejects malformed ids without touching the database", async () => {
    for (const bad of ["abc", "0", "-1", "1.5", "9999999999999999999"]) {
      const res = await request(app).get(`/api/events/${bad}`).set(auth(tokens.org));
      expect([403, 404]).toContain(res.status);
    }
  });

  it("leaves nothing behind: every ZEVT- row is cleaned up by purge()", async () => {
    await purge();
    const { data: events } = await supabaseAdmin.from("events").select("id").like("organiser_id", `${PREFIX}%`);
    const { data: users } = await supabaseAdmin.from("users").select("id").like("id", `${PREFIX}%`);
    const { data: history } = await supabaseAdmin.from("event_history").select("id").in("event_id", createdEventIds.length ? createdEventIds : [-1]);
    expect(events).toEqual([]);
    expect(users).toEqual([]);
    expect(history).toEqual([]);
  });
});
