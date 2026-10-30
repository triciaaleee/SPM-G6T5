import { describe, expect, it, vi } from "vitest";
import { handleEventCancelled } from "../lib/eventCancelledHandler.js";
import { handleEventRejected } from "../lib/eventRejectedHandler.js";
import { handleMessage } from "../lib/handleMessage.js";
import type { InboundMessage } from "../lib/rabbitConsumer.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

// E4-13: reconcileBufferOverlapsSafely (called after releasing a
// cancelled event's bookings) has no caller token here — this runs off a
// RabbitMQ consumer — so it signs an internal token via
// fetchVenueBookingInfoInternal. Mocked the same way sweepExpiringHolds's
// own tests mock it, rather than requiring INTERNAL_SERVICE_SECRET to be
// set just to exercise this path.
const clients = vi.hoisted(() => ({ fetchVenueBookingInfoInternal: vi.fn().mockResolvedValue({ status: "ok", events: [] }) }));
vi.mock("../lib/eventsClient.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/eventsClient.js")>();
  return { ...original, fetchVenueBookingInfoInternal: clients.fetchVenueBookingInfoInternal };
});

function buildMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "11111111-1111-1111-1111-111111111111",
    type: "event.cancelled",
    occurredAt: "2026-10-10T08:15:00Z",
    publisher: "events-service",
    actorId: "ORG-0001",
    eventId: 7,
    recipients: { userIds: ["ORG-0001"], roles: [] },
    data: { eventName: "Spring Gala", reason: "Flooding" },
    ...overrides,
  };
}

/** venue_bookings: every active booking for event 7. venues: their venue rows. */
function buildSupabase(options: {
  bookings?: { id: number; venue_id: number; event_id: number; status: string }[];
  venues?: { id: number; name: string; staff_id: string | null; setup_minutes?: number; turnaround_minutes?: number }[];
  updateError?: boolean;
  venueError?: boolean;
  /** E4-13: rows already in venue_buffer_overlaps before the call. */
  storedOverlaps?: { id: number; venue_id: number; booking_id_a: number; booking_id_b: number }[];
} = {}) {
  const bookings =
    options.bookings ??
    [
      { id: 900, venue_id: 1, event_id: 7, status: "Approved" },
      { id: 901, venue_id: 2, event_id: 7, status: "Requested" },
    ];
  const venues =
    options.venues ??
    [
      { id: 1, name: "Grand Ballroom", staff_id: "VENUE-0001", setup_minutes: 0, turnaround_minutes: 0 },
      { id: 2, name: "Side Hall", staff_id: null, setup_minutes: 0, turnaround_minutes: 0 },
    ];

  const updateSelect = vi.fn().mockResolvedValue(
    options.updateError ? { data: null, error: { message: "boom" } } : { data: bookings, error: null },
  );
  const updateIn = vi.fn().mockReturnValue({ select: updateSelect });
  const updateEq = vi.fn().mockReturnValue({ in: updateIn });
  const update = vi.fn().mockReturnValue({ eq: updateEq });

  const venuesIn = vi.fn().mockResolvedValue(
    options.venueError ? { data: null, error: { message: "boom" } } : { data: venues, error: null },
  );
  // E4-13: reconcileBufferOverlaps also reads venues one row at a time
  // (.eq("id", venueId).maybeSingle()), separate from the bulk .in() lookup
  // just above that builds the publish list.
  const venuesEq = vi.fn((_col: string, value: number) => ({
    maybeSingle: vi.fn().mockResolvedValue({ data: venues.find((v) => v.id === value) ?? null, error: null }),
  }));
  const venuesSelect = vi.fn(() => ({ in: venuesIn, eq: venuesEq }));

  // venue_bookings is also read by reconcileBufferOverlaps's own
  // loadLiveBookings (.eq("venue_id", …).in("status", UNAVAILABLE_BOOKING_STATUSES))
  // — every booking here was just released to Withdrawn, so by default
  // there's nothing left blocking any of these venues.
  const liveBookingsEq = vi.fn(() => ({
    in: vi.fn().mockResolvedValue({ data: [], error: null }),
  }));
  const bookingsSelect = vi.fn(() => ({ eq: liveBookingsEq }));

  let overlapRows = [...(options.storedOverlaps ?? [])];
  const overlapsTable = {
    select: vi.fn(() => {
      let venueId: unknown;
      const q: any = { eq: vi.fn((_c: string, v: unknown) => { venueId = v; return q; }), order: vi.fn(() => q) };
      q.then = (resolve: (v: unknown) => void) => resolve({ data: overlapRows.filter((r) => r.venue_id === venueId), error: null });
      return q;
    }),
    insert: vi.fn((rows: any[]) => {
      overlapRows = [...overlapRows, ...rows.map((r, i) => ({ ...r, id: 7000 + i }))];
      return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
    }),
    delete: vi.fn(() => ({
      in: vi.fn((_c: string, ids: number[]) => {
        overlapRows = overlapRows.filter((r) => !ids.includes(r.id));
        return { then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }) };
      }),
    })),
  };

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "venue_bookings") return { update, select: bookingsSelect };
      if (table === "venues") return { select: venuesSelect };
      if (table === "venue_buffer_overlaps") return overlapsTable;
      throw new Error(`unexpected table ${table}`);
    }),
  };

  return { supabase: supabase as any, update, updateEq, updateIn, venuesSelect, venuesIn, getOverlapRows: () => overlapRows };
}

describe("handleEventCancelled (E3-6 -> AGENTS.md §3a)", () => {
  it("withdraws every active booking and publishes booking.withdrawn to each venue's staff", async () => {
    const { supabase, update, updateEq, updateIn } = buildSupabase();
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventCancelled(buildMsg(), { supabase });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Withdrawn", decided_by: "ORG-0001", hold_expires_at: null }),
    );
    expect(updateEq).toHaveBeenCalledWith("event_id", 7);
    expect(updateIn).toHaveBeenCalledWith("status", ["Requested", "On Hold", "Approved", "Replacement Required"]);

    // Only the venue with a staff member is notified (venue 2 has none).
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      type: "booking.withdrawn",
      eventId: 7,
      actorId: "ORG-0001",
      recipients: { userIds: ["VENUE-0001"], roles: [] },
      data: { bookingId: 900, venueName: "Grand Ballroom", eventName: "Spring Gala", reason: "event_cancelled" },
    });

    setPublisherForTest(undefined);
  });

  it("is a no-op (no venue lookup, no publish) when the event has no active bookings", async () => {
    const { supabase, venuesSelect } = buildSupabase({ bookings: [] });
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventCancelled(buildMsg(), { supabase });

    expect(venuesSelect).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    setPublisherForTest(undefined);
  });

  it("falls back to a generic event name when the message carries none", async () => {
    const { supabase } = buildSupabase();
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventCancelled(buildMsg({ data: { reason: "event_cancelled" } }), { supabase });

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventName: "Event #7" }) }));
    setPublisherForTest(undefined);
  });

  it("is a no-op when the message carries no eventId", async () => {
    const { supabase, update } = buildSupabase();
    await handleEventCancelled(buildMsg({ eventId: null }), { supabase });
    expect(update).not.toHaveBeenCalled();
  });

  it("propagates a failure updating the bookings", async () => {
    const { supabase } = buildSupabase({ updateError: true });
    await expect(handleEventCancelled(buildMsg(), { supabase })).rejects.toBeTruthy();
  });

  describe("E4-13 AC3: releasing a cancelled event's bookings reconciles each affected venue", () => {
    it("removes a stored pair at a venue whose booking was just released", async () => {
      // Booking 900 (venue 1) is released by the cancellation; it was
      // flagged against booking 950. With 900 gone from the blocking set,
      // loadLiveBookings only sees whatever's left (nothing, by default),
      // so the pair can no longer be reported.
      const stale = { id: 6000, venue_id: 1, booking_id_a: 900, booking_id_b: 950 };
      const { supabase, getOverlapRows } = buildSupabase({ storedOverlaps: [stale] });
      setPublisherForTest({ publish: vi.fn().mockResolvedValue(true) });

      await handleEventCancelled(buildMsg(), { supabase });

      expect(getOverlapRows()).toEqual([]);
      setPublisherForTest(undefined);
    });

    it("reconciles once per distinct venue among the released bookings, not once per booking", async () => {
      const { supabase } = buildSupabase();
      setPublisherForTest({ publish: vi.fn().mockResolvedValue(true) });

      await handleEventCancelled(buildMsg(), { supabase });

      // Two released bookings (venue 1 and venue 2) → exactly two
      // venue_buffer_overlaps reads, one per venue, not duplicated.
      const overlapsCalls = supabase.from.mock.calls.filter((call: unknown[]) => call[0] === "venue_buffer_overlaps");
      expect(overlapsCalls).toHaveLength(2);
      setPublisherForTest(undefined);
    });

    it("a reconciliation failure never turns handleEventCancelled's own promise into a rejection", async () => {
      const { supabase } = buildSupabase();
      setPublisherForTest({ publish: vi.fn().mockResolvedValue(true) });
      clients.fetchVenueBookingInfoInternal.mockResolvedValueOnce({ status: "error" });

      await expect(handleEventCancelled(buildMsg(), { supabase })).resolves.toBeUndefined();
      setPublisherForTest(undefined);
    });
  });
});

describe("handleEventRejected (a Planning event rejected through a clarification)", () => {
  it("withdraws every active booking and tells each venue's staff the event was rejected", async () => {
    const { supabase, update, updateEq, updateIn } = buildSupabase();
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventRejected(buildMsg({ type: "event.rejected", data: { eventName: "Spring Gala", reason: "No venue found" } }), { supabase });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "Withdrawn", decided_by: "ORG-0001", hold_expires_at: null }));
    expect(updateEq).toHaveBeenCalledWith("event_id", 7);
    expect(updateIn).toHaveBeenCalledWith("status", ["Requested", "On Hold", "Approved", "Replacement Required"]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      type: "booking.withdrawn",
      eventId: 7,
      actorId: "ORG-0001",
      recipients: { userIds: ["VENUE-0001"], roles: [] },
      data: { bookingId: 900, venueName: "Grand Ballroom", eventName: "Spring Gala", reason: "event_rejected" },
    });
    setPublisherForTest(undefined);
  });

  it("names the event by its number when the message carries no name", async () => {
    const { supabase } = buildSupabase();
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventRejected(buildMsg({ type: "event.rejected", data: { reason: "No venue found" } }), { supabase });

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventName: "Event #7" }) }));
    setPublisherForTest(undefined);
  });

  it("is a no-op when the event has no active bookings, as when it is rejected from Requested", async () => {
    const { supabase, venuesSelect } = buildSupabase({ bookings: [] });
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventRejected(buildMsg({ type: "event.rejected" }), { supabase });

    expect(venuesSelect).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    setPublisherForTest(undefined);
  });

  it("is a no-op when the message carries no eventId", async () => {
    const { supabase, update } = buildSupabase();
    await handleEventRejected(buildMsg({ type: "event.rejected", eventId: null }), { supabase });
    expect(update).not.toHaveBeenCalled();
  });

  it("propagates a failure updating the bookings, so the message goes to the dead-letter queue", async () => {
    const { supabase } = buildSupabase({ updateError: true });
    await expect(handleEventRejected(buildMsg({ type: "event.rejected" }), { supabase })).rejects.toBeTruthy();
  });
});

describe("handleMessage routing for the release messages", () => {
  it("sends event.cancelled to the release, with its own reason", async () => {
    const { supabase } = buildSupabase();
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleMessage(buildMsg({ type: "event.cancelled" }), { supabase });

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: "event_cancelled" }) }));
    setPublisherForTest(undefined);
  });

  it("sends event.rejected to the same release as event.cancelled, with its own reason", async () => {
    const { supabase } = buildSupabase();
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleMessage(buildMsg({ type: "event.rejected" }), { supabase });

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: "event_rejected" }) }));
    setPublisherForTest(undefined);
  });
});
