import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDb } from "./helpers/fakeDb.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

const ev = vi.hoisted(() => ({ fetchVenueBookingInfo: vi.fn(), fetchVenueBookingInfoInternal: vi.fn() }));
vi.mock("../lib/eventsClient.js", async (orig) => ({ ...(await orig<typeof import("../lib/eventsClient.js")>()), ...ev }));

import { reconcileBufferOverlaps, reconcileBufferOverlapsSafely } from "../lib/bufferOverlapReview.js";

const NOW = new Date(2026, 8, 14, 9, 0); // local 2026-09-14 09:00
const event = (id: number, o: Record<string, unknown> = {}) => ({ id, name: `E${id}`, coordinatorId: `C${id}`, proposedDate: "2026-09-15", startTime: "10:00", endTime: "12:00", expectedAttendance: 10, ...o });
const bk = (id: number, event_id: number) => ({ id, venue_id: 1, event_id, status: "Approved", hold_expires_at: null, headcount: null });

/** 10:00–12:00 and 13:00–15:00 with 45 min turnaround/setup → windows touch/overlap. */
function setup(o: { venue?: Record<string, unknown>; stored?: any[]; bookings?: any[] } = {}) {
  const db = createFakeDb({
    venues: [{ id: 1, setup_minutes: 0, turnaround_minutes: 90, ...o.venue }],
    venue_bookings: o.bookings ?? [bk(5, 1), bk(3, 2)],
    venue_buffer_overlaps: o.stored ?? [],
  });
  ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events: [event(1), event(2, { startTime: "13:00", endTime: "15:00" })] });
  ev.fetchVenueBookingInfoInternal.mockResolvedValue({ status: "ok", events: [event(1), event(2, { startTime: "13:00", endTime: "15:00" })] });
  return db;
}
beforeEach(() => {
  ev.fetchVenueBookingInfo.mockReset();
  ev.fetchVenueBookingInfoInternal.mockReset();
  setPublisherForTest(undefined);
});

describe("reconcileBufferOverlaps", () => {
  it("inserts a newly overlapping pair, lower booking id first, with each side's cached window", async () => {
    const db = setup();
    const r = await reconcileBufferOverlaps(db as never, 1, "Bearer t", NOW);
    expect(r!.inserted).toHaveLength(1);
    expect(db.rows("venue_buffer_overlaps")).toEqual([
      { id: 1, venue_id: 1, booking_id_a: 3, booking_id_b: 5, window_a: "2026-09-15 13:00–16:30", window_b: "2026-09-15 10:00–13:30" },
    ]);
  });
  it("keeps each window with the right booking whichever of the two came first", async () => {
    // Same fixture, bookings listed the other way round: now the lower id (3) is the first side.
    const db = setup({ bookings: [bk(3, 2), bk(5, 1)] });
    await reconcileBufferOverlaps(db as never, 1, "Bearer t", NOW);
    expect(db.rows("venue_buffer_overlaps")).toEqual([
      { id: 1, venue_id: 1, booking_id_a: 3, booking_id_b: 5, window_a: "2026-09-15 13:00–16:30", window_b: "2026-09-15 10:00–13:30" },
    ]);
  });
  it("a stored pair does not hide a different pair that has just started to overlap", async () => {
    const db = setup({
      bookings: [bk(5, 1), bk(3, 2), bk(7, 3), bk(8, 4)],
      stored: [{ id: 77, venue_id: 1, booking_id_a: 3, booking_id_b: 5, window_a: "old", window_b: "old" }],
    });
    const day2 = { proposedDate: "2026-09-16" };
    const events = [
      event(1),
      event(2, { startTime: "13:00", endTime: "15:00" }),
      event(3, day2),
      event(4, { ...day2, startTime: "13:00", endTime: "15:00" }),
    ];
    ev.fetchVenueBookingInfo.mockResolvedValue({ status: "ok", events });

    const r = await reconcileBufferOverlaps(db as never, 1, "Bearer t", NOW);

    expect(r!.inserted.map((o) => [o.first.bookingId, o.second.bookingId])).toEqual([[7, 8]]);
    expect(db.rows("venue_buffer_overlaps").map((row) => [row.booking_id_a, row.booking_id_b])).toEqual([[3, 5], [7, 8]]);
  });
  it("leaves a still-overlapping stored pair untouched and reports nothing new", async () => {
    const db = setup({ stored: [{ id: 77, venue_id: 1, booking_id_a: 3, booking_id_b: 5, window_a: "old", window_b: "old" }] });
    const r = await reconcileBufferOverlaps(db as never, 1, "Bearer t", NOW);
    expect(r).toEqual({ inserted: [] });
    expect(db.rows("venue_buffer_overlaps")).toEqual([{ id: 77, venue_id: 1, booking_id_a: 3, booking_id_b: 5, window_a: "old", window_b: "old" }]);
    expect(db.writes("venue_buffer_overlaps")).toHaveLength(0);
  });
  it("deletes stored pairs that no longer overlap, and only those", async () => {
    const db = setup({
      venue: { turnaround_minutes: 0 },
      stored: [{ id: 77, venue_id: 1, booking_id_a: 3, booking_id_b: 5 }, { id: 78, venue_id: 1, booking_id_a: 8, booking_id_b: 9 }],
    });
    const r = await reconcileBufferOverlaps(db as never, 1, "Bearer t", NOW);
    expect(r).toEqual({ inserted: [] });
    expect(db.rows("venue_buffer_overlaps")).toEqual([]);
  });
  it("matches stored pairs regardless of the id order they were stored in", async () => {
    const db = setup({ stored: [{ id: 77, venue_id: 1, booking_id_a: 5, booking_id_b: 3 }] });
    expect(await reconcileBufferOverlaps(db as never, 1, "Bearer t", NOW)).toEqual({ inserted: [] });
    expect(db.rows("venue_buffer_overlaps")).toHaveLength(1);
  });
  it("is a no-op for a venue with no bookings", async () => {
    const db = setup({ bookings: [] });
    expect(await reconcileBufferOverlaps(db as never, 1, "Bearer t", NOW)).toEqual({ inserted: [] });
  });
  it("a venue with null setup/turnaround is treated as 0/0", async () => {
    const db = setup({ venue: { setup_minutes: null, turnaround_minutes: null } });
    expect(await reconcileBufferOverlaps(db as never, 1, "Bearer t", NOW)).toEqual({ inserted: [] });
  });
  it("uses the internal lookup when there is no caller token", async () => {
    const db = setup();
    await reconcileBufferOverlaps(db as never, 1, null, NOW);
    expect(ev.fetchVenueBookingInfoInternal).toHaveBeenCalled();
    expect(ev.fetchVenueBookingInfo).not.toHaveBeenCalled();
  });
  it("defaults now to the real clock", async () => {
    const db = setup({ bookings: [] });
    expect(await reconcileBufferOverlaps(db as never, 1, "Bearer t")).toEqual({ inserted: [] });
  });

  describe("returns null (and stops) when something fails", () => {
    it("the venue lookup errors or the venue is missing", async () => {
      const db = setup();
      db.failOn("venues", "select");
      expect(await reconcileBufferOverlaps(db as never, 1, "t", NOW)).toBeNull();
      expect(await reconcileBufferOverlaps(setup() as never, 99, "t", NOW)).toBeNull();
    });
    it("the live bookings cannot be loaded", async () => {
      const db = setup();
      db.failOn("venue_bookings", "select");
      expect(await reconcileBufferOverlaps(db as never, 1, "t", NOW)).toBeNull();
      const db2 = setup();
      ev.fetchVenueBookingInfo.mockResolvedValue({ status: "error" });
      expect(await reconcileBufferOverlaps(db2 as never, 1, "t", NOW)).toBeNull();
    });
    it("the stored rows cannot be read", async () => {
      const db = setup();
      db.failOn("venue_buffer_overlaps", "select");
      expect(await reconcileBufferOverlaps(db as never, 1, "t", NOW)).toBeNull();
    });
    it("the insert fails (nothing stored)", async () => {
      const db = setup();
      db.failOn("venue_buffer_overlaps", "insert");
      expect(await reconcileBufferOverlaps(db as never, 1, "t", NOW)).toBeNull();
      expect(db.rows("venue_buffer_overlaps")).toEqual([]);
    });
    it("the delete fails (row kept)", async () => {
      const db = setup({ venue: { turnaround_minutes: 0 }, stored: [{ id: 77, venue_id: 1, booking_id_a: 3, booking_id_b: 5 }] });
      db.failOn("venue_buffer_overlaps", "delete");
      expect(await reconcileBufferOverlaps(db as never, 1, "t", NOW)).toBeNull();
      expect(db.rows("venue_buffer_overlaps")).toHaveLength(1);
    });
  });
});

describe("reconcileBufferOverlapsSafely", () => {
  const published: any[] = [];
  beforeEach(() => {
    published.length = 0;
    setPublisherForTest({ publish: async (m) => { published.push(m); return true; } });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("notifies the venue's staff and both coordinators for newly inserted pairs", async () => {
    const db = setup();
    await reconcileBufferOverlapsSafely(db as never, 1, "Bearer t", { now: NOW, venueName: "Hall", venueStaffId: "STAFF" });
    expect(published.map((m) => m.recipients.userIds[0]).sort()).toEqual(["C1", "C2", "STAFF"]);
    expect(published.every((m) => m.type === "booking.setup_conflict" && m.data.venueName === "Hall")).toBe(true);
  });
  it("sends nothing when no pair is new, when the venue name is not given, or when reconciling failed", async () => {
    await reconcileBufferOverlapsSafely(setup({ stored: [{ id: 1, venue_id: 1, booking_id_a: 3, booking_id_b: 5 }] }) as never, 1, "t", { now: NOW, venueName: "Hall" });
    await reconcileBufferOverlapsSafely(setup() as never, 1, "t", { now: NOW });
    const failing = setup();
    failing.failOn("venues", "select");
    await reconcileBufferOverlapsSafely(failing as never, 1, "t", { now: NOW, venueName: "Hall" });
    expect(published).toEqual([]);
  });
  it("passes no staff recipient when venueStaffId is absent", async () => {
    await reconcileBufferOverlapsSafely(setup() as never, 1, "t", { now: NOW, venueName: "Hall", venueStaffId: undefined });
    expect(published.map((m) => m.recipients.userIds[0]).sort()).toEqual(["C1", "C2"]);
  });
  it("swallows and logs anything thrown (publisher crash), never rejecting", async () => {
    setPublisherForTest({ publish: async () => { throw new Error("broker exploded"); } });
    await expect(reconcileBufferOverlapsSafely(setup() as never, 1, "t", { now: NOW, venueName: "Hall", venueStaffId: "S" })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("[buffer-overlap-review] reconciliation failed for venue 1", expect.any(Error));
  });
  it("defaults `now` and options", async () => {
    await expect(reconcileBufferOverlapsSafely(setup({ bookings: [] }) as never, 1, "t")).resolves.toBeUndefined();
  });
});
