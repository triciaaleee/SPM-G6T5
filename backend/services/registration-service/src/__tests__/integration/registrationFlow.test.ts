/**
 * Real-DB integration: the REST routes through the real app, the real
 * requireAuth and the real register_for_event function (migration 0040),
 * including its per-event lock. The other services are replaced at their
 * client modules: what they answer isn't under test here, only what this
 * service does with its own table. The broker is replaced with a fake.
 */
import "../../lib/env.js";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const clients = vi.hoisted(() => ({
  fetchAttendeeEvents: vi.fn(),
  fetchOpenEvents: vi.fn(),
  canViewEvent: vi.fn(),
  fetchVenueNames: vi.fn(),
  fetchUserNames: vi.fn(),
}));
vi.mock("../../lib/eventsClient.js", () => ({
  fetchAttendeeEvents: clients.fetchAttendeeEvents,
  fetchOpenEvents: clients.fetchOpenEvents,
  canViewEvent: clients.canViewEvent,
}));
vi.mock("../../lib/venuesClient.js", () => ({ fetchVenueNames: clients.fetchVenueNames }));
vi.mock("../../lib/usersClient.js", () => ({ fetchUserNames: clients.fetchUserNames }));

import { app } from "../../app.js";
import { handleEventCancelled } from "../../lib/eventCancelledHandler.js";
import { createFakePublisher } from "../../lib/rabbitPublisher.fake.js";
import { setPublisherForTest } from "../../lib/rabbitPublisher.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { ORGANISER, attendeeId, auth, seedEvent, seedUsers, teardown } from "./helpers.js";

const URL = "/api/registrations";

type EventOverrides = Record<string, unknown>;

function eventsAnswer(eventId: number, overrides: EventOverrides = {}) {
  return { status: "ok", events: [{ id: eventId, name: "ZINT Gala", capacity: null, registrationNeeded: true, open: true, ...overrides }] };
}

async function placeOf(eventId: number, userId: string) {
  const { data, error } = await supabaseAdmin
    .from("registrations")
    .select("registration_id, status, additional_info, created_at")
    .eq("event_id", eventId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read registration: ${error.message}`);
  return data;
}

const cancelMsg = (eventId: number) => ({
  messageId: "11111111-1111-1111-1111-111111111111",
  type: "event.cancelled",
  occurredAt: "2026-10-10T08:15:00.000Z",
  publisher: "events-service",
  actorId: ORGANISER,
  eventId,
  recipients: { userIds: [], roles: [] },
  data: { eventName: "ZINT Gala" },
});

const register = (eventId: number, userId: string, extra: Record<string, unknown> = {}) =>
  request(app).post(URL).set("Authorization", auth(userId)).send({ eventId, ...extra });
const withdraw = (eventId: number, userId: string) =>
  request(app).patch(`${URL}/event/${eventId}/withdraw`).set("Authorization", auth(userId));

describe("registrations (real Supabase project)", () => {
  let publisher: ReturnType<typeof createFakePublisher>;

  beforeAll(async () => {
    await seedUsers(8);
  });
  afterAll(teardown);

  beforeEach(() => {
    publisher = createFakePublisher();
    setPublisherForTest(publisher);
    clients.fetchVenueNames.mockResolvedValue({ status: "ok", venuesByEvent: new Map() });
    clients.fetchUserNames.mockResolvedValue(new Map());
    clients.canViewEvent.mockResolvedValue({ status: "ok" });
  });

  it("refuses a request with no token and one for another attendee", async () => {
    expect((await request(app).get(`${URL}/open-events`)).status).toBe(401);
    const res = await request(app).get(`${URL}/user/${attendeeId(2)}`).set("Authorization", auth(attendeeId(1)));
    expect(res.status).toBe(403);
  });

  it("registers, refuses a duplicate, withdraws, then re-registers on the same row", async () => {
    const eventId = await seedEvent();
    clients.fetchAttendeeEvents.mockResolvedValue(eventsAnswer(eventId));
    const user = attendeeId(1);

    const first = await register(eventId, user, { additionalInfo: { diet: "veg" } });
    expect(first.status).toBe(201);
    expect(first.body.registration).toMatchObject({ eventId, userId: user, status: "Registered", additionalInfo: { diet: "veg" } });
    const original = await placeOf(eventId, user);

    const duplicate = await register(eventId, user);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("already_registered");

    const out = await withdraw(eventId, user);
    expect(out.status).toBe(200);
    expect((await placeOf(eventId, user))?.status).toBe("Withdrawn");

    const again = await withdraw(eventId, user);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("already_withdrawn");

    // Leaving additionalInfo out keeps what was there, on the same row with its original created_at.
    const back = await register(eventId, user);
    expect(back.status).toBe(200);
    const returned = await placeOf(eventId, user);
    expect(returned).toEqual({ ...original, status: "Registered" });

    await withdraw(eventId, user);
    await register(eventId, user, { additionalInfo: { diet: "halal" } });
    expect((await placeOf(eventId, user))?.additional_info).toEqual({ diet: "halal" });
    expect(publisher.published.map((m) => m.type)).toEqual([
      "registration.confirmed",
      "registration.withdrawn",
      "registration.confirmed",
      "registration.withdrawn",
      "registration.confirmed",
    ]);
  });

  it("lets exactly one of two attendees take the last place (migration 0040's lock)", async () => {
    const eventId = await seedEvent();
    clients.fetchAttendeeEvents.mockResolvedValue(eventsAnswer(eventId, { capacity: 1 }));

    const results = await Promise.all([register(eventId, attendeeId(1)), register(eventId, attendeeId(2))]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe("event_full");
  });

  it("never goes over capacity when several attendees register at once", async () => {
    const eventId = await seedEvent();
    clients.fetchAttendeeEvents.mockResolvedValue(eventsAnswer(eventId, { capacity: 3 }));

    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => register(eventId, attendeeId(i + 1))));

    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    const { count } = await supabaseAdmin
      .from("registrations")
      .select("registration_id", { count: "exact", head: true })
      .eq("event_id", eventId)
      .eq("status", "Registered");
    expect(count).toBe(3);
  });

  it("frees a place at once when someone withdraws, and counts it in slotsLeft", async () => {
    const eventId = await seedEvent();
    clients.fetchAttendeeEvents.mockResolvedValue(eventsAnswer(eventId, { capacity: 1, registrationState: "OPEN" }));

    await register(eventId, attendeeId(1));
    const full = await request(app).get(`${URL}/event/${eventId}/view`).set("Authorization", auth(attendeeId(2)));
    expect(full.body.event).toMatchObject({ slotsLeft: 0, registrationState: "FULL", registrationStatus: null });
    expect((await register(eventId, attendeeId(2))).body.code).toBe("event_full");

    await withdraw(eventId, attendeeId(1));

    const freed = await request(app).get(`${URL}/event/${eventId}/view`).set("Authorization", auth(attendeeId(2)));
    expect(freed.body.event).toMatchObject({ slotsLeft: 1, registrationState: "OPEN" });
    expect((await register(eventId, attendeeId(2))).status).toBe(201);
  });

  it("cancelling an event ends only Registered places, notifies those attendees once, and stays final", async () => {
    const eventId = await seedEvent();
    clients.fetchAttendeeEvents.mockResolvedValue(eventsAnswer(eventId));
    await register(eventId, attendeeId(1));
    await register(eventId, attendeeId(2));
    await register(eventId, attendeeId(3));
    await withdraw(eventId, attendeeId(3));
    publisher.published.length = 0;

    await handleEventCancelled(cancelMsg(eventId), { supabase: supabaseAdmin });
    await handleEventCancelled(cancelMsg(eventId), { supabase: supabaseAdmin });

    expect((await placeOf(eventId, attendeeId(1)))?.status).toBe("Cancelled");
    expect((await placeOf(eventId, attendeeId(2)))?.status).toBe("Cancelled");
    expect((await placeOf(eventId, attendeeId(3)))?.status).toBe("Withdrawn");
    expect(publisher.published).toHaveLength(1);
    expect(publisher.published[0].recipients.userIds.sort()).toEqual([attendeeId(1), attendeeId(2)].sort());

    const refused = await withdraw(eventId, attendeeId(1));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("event_cancelled");
    clients.fetchAttendeeEvents.mockResolvedValue(eventsAnswer(eventId, { open: false, viewable: false }));
    const view = await request(app).get(`${URL}/event/${eventId}/view`).set("Authorization", auth(attendeeId(1)));
    expect(view.status).toBe(200);
    expect(view.body.event.registrationStatus).toBe("Cancelled");
  });

  it("a cancellation landing during a withdrawal stays Cancelled, and tells nobody they withdrew", async () => {
    const eventId = await seedEvent();
    clients.fetchAttendeeEvents.mockResolvedValue(eventsAnswer(eventId));
    await register(eventId, attendeeId(1));
    publisher.published.length = 0;

    // The route fetches the event between reading the place and giving it up, so cancel right then.
    clients.fetchAttendeeEvents.mockImplementationOnce(async () => {
      await handleEventCancelled(cancelMsg(eventId), { supabase: supabaseAdmin });
      return eventsAnswer(eventId);
    });
    const res = await withdraw(eventId, attendeeId(1));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("no_place");
    expect((await placeOf(eventId, attendeeId(1)))?.status).toBe("Cancelled");
    expect(publisher.published.map((m) => m.type)).toEqual(["registration.cancelled_by_event"]);
  });

  it("shows the roster oldest first with every status, and lists the attendee's own newest first", async () => {
    const eventId = await seedEvent();
    const laterId = await seedEvent();
    clients.fetchAttendeeEvents.mockImplementation(async (ids: number[]) => eventsAnswer(ids[0]));
    await register(eventId, attendeeId(1));
    await register(eventId, attendeeId(2));
    await withdraw(eventId, attendeeId(2));
    await register(laterId, attendeeId(1));

    const roster = await request(app).get(`${URL}/event/${eventId}`).set("Authorization", auth(ORGANISER, "organiser"));
    expect(roster.body.registrations.map((r: { userId: string; status: string }) => [r.userId, r.status])).toEqual([
      [attendeeId(1), "Registered"],
      [attendeeId(2), "Withdrawn"],
    ]);

    clients.fetchAttendeeEvents.mockResolvedValue({ status: "ok", events: [] });
    const mine = await request(app).get(`${URL}/user/${attendeeId(1)}`).set("Authorization", auth(attendeeId(1)));
    const ids = mine.body.registrations.map((r: { eventId: number }) => r.eventId);
    expect(ids.indexOf(laterId)).toBeLessThan(ids.indexOf(eventId));
    expect(ids.indexOf(laterId)).toBeGreaterThanOrEqual(0);
  });

  it("the database refuses a second row for one attendee, an unknown status and an unknown event", async () => {
    const eventId = await seedEvent();
    const row = { event_id: eventId, user_id: attendeeId(1) };
    expect((await supabaseAdmin.from("registrations").insert(row)).error).toBeNull();

    expect((await supabaseAdmin.from("registrations").insert(row)).error?.code).toBe("23505");
    expect((await supabaseAdmin.from("registrations").update({ status: "Pending" }).eq("event_id", eventId)).error?.code).toBe("22P02");
    expect((await supabaseAdmin.from("registrations").insert({ event_id: 2147483647, user_id: attendeeId(1) })).error?.code).toBe("23503");
  });

  it("an id too big for the column errors in Postgres, so the routes refuse it first", async () => {
    const query = await supabaseAdmin.from("registrations").select("status").eq("event_id", 2147483648);
    expect(query.error?.code).toBe("22003");

    const res = await request(app).get(`${URL}/event/2147483648/view`).set("Authorization", auth(attendeeId(1)));
    expect(res.status).toBe(400);
  });

  it("removes an event's registrations with the event", async () => {
    const eventId = await seedEvent();
    clients.fetchAttendeeEvents.mockResolvedValue(eventsAnswer(eventId));
    await register(eventId, attendeeId(1));

    await supabaseAdmin.from("events").delete().eq("id", eventId);

    expect(await placeOf(eventId, attendeeId(1))).toBeNull();
  });
});
