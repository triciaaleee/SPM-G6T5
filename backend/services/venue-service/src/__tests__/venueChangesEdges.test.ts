import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bufferOverlapNotifications,
  findAllBufferOverlaps,
  findBufferOverlaps,
  findCapacityShortfalls,
  impactNotifications,
  loadLiveBookings,
  localDateKey,
  normalizePair,
  toPublicImpact,
  type LiveBooking,
} from "../lib/venueChanges.js";
import { createFakeDb } from "./helpers/fakeDb.js";

const ev = vi.hoisted(() => ({ fetchVenueBookingInfo: vi.fn(), fetchVenueBookingInfoInternal: vi.fn() }));
vi.mock("../lib/eventsClient.js", async (orig) => ({ ...(await orig<typeof import("../lib/eventsClient.js")>()), ...ev }));

const event = (id: number, o: Record<string, unknown> = {}) =>
  ({ id, name: `E${id}`, coordinatorId: `C${id}`, proposedDate: "2026-09-15", startTime: "10:00", endTime: "12:00", expectedAttendance: 100, ...o }) as never;
const live = (id: number, eventId: number, o: Record<string, unknown> = {}, eo: Record<string, unknown> = {}): LiveBooking =>
  ({ id, status: "Approved", event: event(eventId, eo), headcount: null, ...o }) as LiveBooking;
const TODAY = "2026-09-15";

describe("localDateKey", () => {
  it("zero-pads month and day from local time", () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(localDateKey(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });
});

describe("findCapacityShortfalls", () => {
  it("is empty unless capacity strictly goes down (equal or up → nothing)", () => {
    const b = [live(1, 1, {}, { expectedAttendance: 500 })];
    expect(findCapacityShortfalls(b, 100, 100, TODAY)).toEqual([]);
    expect(findCapacityShortfalls(b, 100, 101, TODAY)).toEqual([]);
    expect(findCapacityShortfalls(b, 100, 99, TODAY)).toHaveLength(1);
  });
  it("attendance equal to the new capacity fits; one over does not", () => {
    expect(findCapacityShortfalls([live(1, 1, {}, { expectedAttendance: 50 })], 100, 50, TODAY)).toEqual([]);
    expect(findCapacityShortfalls([live(1, 1, {}, { expectedAttendance: 51 })], 100, 50, TODAY)).toHaveLength(1);
  });
  it("only counts Approved bookings", () => {
    for (const status of ["On Hold", "Requested"]) expect(findCapacityShortfalls([live(1, 1, { status })], 100, 10, TODAY)).toEqual([]);
  });
  it("only counts events today or later (yesterday is ignored, today is kept), and dated ones", () => {
    expect(findCapacityShortfalls([live(1, 1, {}, { proposedDate: "2026-09-14" })], 100, 10, TODAY)).toEqual([]);
    expect(findCapacityShortfalls([live(1, 1, {}, { proposedDate: "2026-09-15" })], 100, 10, TODAY)).toHaveLength(1);
    expect(findCapacityShortfalls([live(1, 1, {}, { proposedDate: null })], 100, 10, TODAY)).toEqual([]);
  });
  it("prefers the booking's own headcount over the event's attendance", () => {
    expect(findCapacityShortfalls([live(1, 1, { headcount: 20 }, { expectedAttendance: 500 })], 100, 30, TODAY)).toEqual([]);
    expect(findCapacityShortfalls([live(1, 1, { headcount: 40 }, { expectedAttendance: 5 })], 100, 30, TODAY)[0].expectedAttendance).toBe(40);
  });
  it("reads a string attendance, and ignores null / non-numeric attendance", () => {
    expect(findCapacityShortfalls([live(1, 1, {}, { expectedAttendance: "80" })], 100, 50, TODAY)[0].expectedAttendance).toBe(80);
    expect(findCapacityShortfalls([live(1, 1, {}, { expectedAttendance: null })], 100, 50, TODAY)).toEqual([]);
    expect(findCapacityShortfalls([live(1, 1, {}, { expectedAttendance: "many" })], 100, 50, TODAY)).toEqual([]);
  });
  it("reports the full shortfall shape, with a null coordinator when there is none", () => {
    expect(findCapacityShortfalls([live(7, 3, {}, { coordinatorId: undefined })], 100, 10, TODAY)).toEqual([
      { bookingId: 7, eventId: 3, eventName: "E3", date: "2026-09-15", expectedAttendance: 100, coordinatorId: null },
    ]);
  });
});

describe("buffer overlaps", () => {
  // 10:00–12:00 and 13:00–15:00; a gap of 60 minutes between them
  const a = live(1, 1);
  const b = live(2, 2, {}, { startTime: "13:00", endTime: "15:00" });
  const none = { setup_minutes: 0, turnaround_minutes: 0 };

  it("two windows touching exactly do not overlap; one minute more does", () => {
    expect(findAllBufferOverlaps([a, b], { setup_minutes: 0, turnaround_minutes: 30 }, TODAY)).toEqual([]);
    expect(findAllBufferOverlaps([a, b], { setup_minutes: 30, turnaround_minutes: 30 }, TODAY)).toEqual([]); // 12:30 vs 12:30
    expect(findAllBufferOverlaps([a, b], { setup_minutes: 31, turnaround_minutes: 30 }, TODAY)).toHaveLength(1);
    expect(findAllBufferOverlaps([a, b], { setup_minutes: 0, turnaround_minutes: 61 }, TODAY)).toHaveLength(1);
  });
  it("reports both sides with formatted windows and coordinators", () => {
    const [pair] = findAllBufferOverlaps([a, b], { setup_minutes: 0, turnaround_minutes: 90 }, TODAY);
    expect(pair.first).toEqual({ bookingId: 1, eventId: 1, eventName: "E1", window: "2026-09-15 10:00–13:30", coordinatorId: "C1" });
    expect(pair.second).toEqual({ bookingId: 2, eventId: 2, eventName: "E2", window: "2026-09-15 13:00–16:30", coordinatorId: "C2" });
  });
  it("ignores past and undated bookings, and two bookings of the same event", () => {
    const wide = { setup_minutes: 120, turnaround_minutes: 120 };
    expect(findAllBufferOverlaps([a, live(2, 2, {}, { proposedDate: "2026-09-14" })], wide, TODAY)).toEqual([]);
    expect(findAllBufferOverlaps([a, live(2, 2, {}, { proposedDate: null })], wide, TODAY)).toEqual([]);
    expect(findAllBufferOverlaps([a, live(2, 2, {}, { proposedDate: "garbage" })], wide, TODAY)).toEqual([]);
    expect(findAllBufferOverlaps([a, live(2, 1, {}, { startTime: "10:30" })], wide, TODAY)).toEqual([]);
  });
  it("different days never overlap", () => {
    expect(findAllBufferOverlaps([a, live(2, 2, {}, { proposedDate: "2026-09-16" })], { setup_minutes: 60, turnaround_minutes: 60 }, TODAY)).toEqual([]);
  });
  it("findBufferOverlaps returns nothing when the padding is unchanged (null = 0) and only the NEW overlaps otherwise", () => {
    expect(findBufferOverlaps([a, b], none, { setup_minutes: null, turnaround_minutes: null }, TODAY)).toEqual([]);
    expect(findBufferOverlaps([a, b], { setup_minutes: 5, turnaround_minutes: 5 }, { setup_minutes: 5, turnaround_minutes: 5 }, TODAY)).toEqual([]);
    expect(findBufferOverlaps([a, b], none, { setup_minutes: 0, turnaround_minutes: 90 }, TODAY)).toHaveLength(1);
    // already overlapping before → not new
    expect(findBufferOverlaps([a, b], { setup_minutes: 0, turnaround_minutes: 90 }, { setup_minutes: 0, turnaround_minutes: 120 }, TODAY)).toEqual([]);
    // overlapped before, resolved by shrinking → nothing new
    expect(findBufferOverlaps([a, b], { setup_minutes: 0, turnaround_minutes: 90 }, none, TODAY)).toEqual([]);
  });
  it("a change in only one of setup/turnaround counts as a change", () => {
    expect(findBufferOverlaps([a, b], none, { setup_minutes: 0, turnaround_minutes: 90 }, TODAY)).toHaveLength(1);
    expect(findBufferOverlaps([a, b], none, { setup_minutes: 90, turnaround_minutes: 0 }, TODAY)).toHaveLength(1);
  });
  it("matches a pair regardless of which booking came first", () => {
    const wide = { setup_minutes: 0, turnaround_minutes: 90 };
    expect(findBufferOverlaps([b, a], { setup_minutes: 0, turnaround_minutes: 90 }, wide, TODAY)).toEqual([]);
    expect(findBufferOverlaps([b, a], none, wide, TODAY)).toHaveLength(1);
  });
});

describe("normalizePair", () => {
  it("puts the lower id first", () => {
    expect(normalizePair(1, 2)).toEqual([1, 2]);
    expect(normalizePair(9, 3)).toEqual([3, 9]);
    expect(normalizePair(4, 4)).toEqual([4, 4]);
  });
});

describe("notifications", () => {
  const overlap = (cA: string | null, cB: string | null, eA = 1, eB = 2) => ({
    first: { bookingId: 1, eventId: eA, eventName: "A", window: "wa", coordinatorId: cA },
    second: { bookingId: 2, eventId: eB, eventName: "B", window: "wb", coordinatorId: cB },
  });

  it("tells the venue's staff once per pair and each coordinator about the other event", () => {
    const m = bufferOverlapNotifications("Hall", [overlap("CA", "CB")], "STAFF");
    expect(m).toHaveLength(3);
    expect(m[0]).toEqual({
      type: "booking.setup_conflict", eventId: 1, actorId: null, recipients: { userIds: ["STAFF"], roles: [] },
      data: { venueName: "Hall", venueStaffId: "STAFF", first: { eventName: "A", window: "wa" }, second: { eventName: "B", window: "wb" } },
    });
    expect(m[1]).toEqual({
      type: "booking.setup_conflict", eventId: 1, actorId: null, recipients: { userIds: ["CA"], roles: [] },
      data: { venueName: "Hall", venueStaffId: "STAFF", eventName: "A", window: "wa", otherEventName: "B", otherEventId: 2, otherWindow: "wb" },
    });
    expect(m[2]).toMatchObject({ eventId: 2, recipients: { userIds: ["CB"] }, data: { eventName: "B", otherEventName: "A", otherEventId: 1, otherWindow: "wa" } });
  });
  it("no staff → no staff message; no coordinator → no coordinator message", () => {
    expect(bufferOverlapNotifications("Hall", [overlap("CA", "CB")], null).map((x) => x.recipients.userIds[0])).toEqual(["CA", "CB"]);
    expect(bufferOverlapNotifications("Hall", [overlap(null, "CB")], "S").map((x) => x.recipients.userIds[0])).toEqual(["S", "CB"]);
    expect(bufferOverlapNotifications("Hall", [overlap(null, null)], null)).toEqual([]);
  });
  it("tells an event's coordinator only once even if the event is in two overlaps, but staff once per pair", () => {
    const m = bufferOverlapNotifications("Hall", [overlap("CA", "CB", 1, 2), overlap("CA", "CC", 1, 3)], "S");
    const to = m.map((x) => x.recipients.userIds[0]);
    expect(to.filter((u) => u === "S")).toHaveLength(2);
    expect(to.filter((u) => u === "CA")).toHaveLength(1);
    expect(to.filter((u) => u === "CB")).toHaveLength(1);
    expect(to.filter((u) => u === "CC")).toHaveLength(1);
  });
  it("honours a pre-filled `told` set across calls", () => {
    const told = new Set(["overlap:CA:1"]);
    expect(bufferOverlapNotifications("Hall", [overlap("CA", "CB")], null, told).map((x) => x.recipients.userIds[0])).toEqual(["CB"]);
  });

  it("impactNotifications: capacity message per shortfall with coordinator, then overlap messages", () => {
    const impact = {
      capacityShortfalls: [
        { bookingId: 1, eventId: 1, eventName: "A", date: "2026-09-15", expectedAttendance: 90, coordinatorId: "CA" },
        { bookingId: 2, eventId: 2, eventName: "B", date: "2026-09-16", expectedAttendance: 80, coordinatorId: null },
      ],
      bufferOverlaps: [overlap("CA", "CB")],
    };
    const m = impactNotifications("Hall", impact, 50, "S");
    expect(m[0]).toEqual({
      type: "venue.capacity_reduced", eventId: 1, actorId: null, recipients: { userIds: ["CA"], roles: [] },
      data: { venueName: "Hall", capacity: 50, eventName: "A", date: "2026-09-15", expectedAttendance: 90 },
    });
    expect(m.map((x) => x.type)).toEqual(["venue.capacity_reduced", "booking.setup_conflict", "booking.setup_conflict", "booking.setup_conflict"]);
    expect(impactNotifications("Hall", { capacityShortfalls: [], bufferOverlaps: [] }, 50, "S")).toEqual([]);
  });

  it("toPublicImpact strips coordinator ids into hasCoordinator flags", () => {
    const out = toPublicImpact({
      capacityShortfalls: [
        { bookingId: 1, eventId: 1, eventName: "A", date: "d", expectedAttendance: 9, coordinatorId: "CA" },
        { bookingId: 2, eventId: 2, eventName: "B", date: "d", expectedAttendance: 9, coordinatorId: null },
      ],
      bufferOverlaps: [overlap("CA", null)],
    });
    expect(out.capacityShortfalls.map((s) => s.hasCoordinator)).toEqual([true, false]);
    expect(out.bufferOverlaps[0].first).toMatchObject({ hasCoordinator: true });
    expect(out.bufferOverlaps[0].second).toMatchObject({ hasCoordinator: false });
    expect(JSON.stringify(out)).not.toContain('"coordinatorId"');
  });
});

describe("loadLiveBookings", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  beforeEach(() => {
    ev.fetchVenueBookingInfo.mockReset().mockResolvedValue({ status: "ok", events: [event(5), event(6)] });
    ev.fetchVenueBookingInfoInternal.mockReset().mockResolvedValue({ status: "ok", events: [event(5), event(6)] });
  });

  it("null when the bookings lookup fails", async () => {
    const db = createFakeDb();
    db.failOn("venue_bookings", "select");
    expect(await loadLiveBookings(db as never, 1, "Bearer t", now)).toBeNull();
  });
  it("[] without calling events-service when nothing holds the venue", async () => {
    const db = createFakeDb({ venue_bookings: [{ id: 1, venue_id: 1, event_id: 5, status: "Requested" }] });
    expect(await loadLiveBookings(db as never, 1, "Bearer t", now)).toEqual([]);
    expect(ev.fetchVenueBookingInfo).not.toHaveBeenCalled();
  });
  it("keeps Approved and unexpired On Hold, drops an On Hold that expired at or before now", async () => {
    const db = createFakeDb({
      venue_bookings: [
        { id: 1, venue_id: 1, event_id: 5, status: "Approved", hold_expires_at: null, headcount: 30 },
        { id: 2, venue_id: 1, event_id: 6, status: "On Hold", hold_expires_at: "2026-09-14T12:00:00.001Z" },
        { id: 3, venue_id: 1, event_id: 7, status: "On Hold", hold_expires_at: "2026-09-14T12:00:00.000Z" },
        { id: 4, venue_id: 2, event_id: 5, status: "Approved" },
      ],
    });
    const out = await loadLiveBookings(db as never, 1, "Bearer t", now);
    expect(out!.map((x) => [x.id, x.headcount])).toEqual([[1, 30], [2, null]]);
    expect(ev.fetchVenueBookingInfo).toHaveBeenCalledWith([5, 6], "Bearer t");
  });
  it("drops bookings whose event is unknown to events-service", async () => {
    const db = createFakeDb({ venue_bookings: [{ id: 1, venue_id: 1, event_id: 5, status: "Approved" }, { id: 2, venue_id: 1, event_id: 99, status: "Approved" }] });
    expect((await loadLiveBookings(db as never, 1, "Bearer t", now))!.map((x) => x.id)).toEqual([1]);
  });
  it("null when events-service fails", async () => {
    const db = createFakeDb({ venue_bookings: [{ id: 1, venue_id: 1, event_id: 5, status: "Approved" }] });
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
    expect(await loadLiveBookings(db as never, 1, "Bearer t", now)).toBeNull();
  });
  it("without a caller token it uses the internal lookup instead", async () => {
    const db = createFakeDb({ venue_bookings: [{ id: 1, venue_id: 1, event_id: 5, status: "Approved" }] });
    expect((await loadLiveBookings(db as never, 1, null, now))!.map((x) => x.id)).toEqual([1]);
    expect(ev.fetchVenueBookingInfoInternal).toHaveBeenCalledWith([5]);
    expect(ev.fetchVenueBookingInfo).not.toHaveBeenCalled();
  });
  it("defaults `now` to the real clock", async () => {
    const db = createFakeDb({ venue_bookings: [{ id: 1, venue_id: 1, event_id: 5, status: "On Hold", hold_expires_at: new Date(Date.now() + 60_000).toISOString() }, { id: 2, venue_id: 1, event_id: 6, status: "On Hold", hold_expires_at: new Date(Date.now() - 60_000).toISOString() }] });
    expect((await loadLiveBookings(db as never, 1, "Bearer t"))!.map((x) => x.id)).toEqual([1]);
  });
});
