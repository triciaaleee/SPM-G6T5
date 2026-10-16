import { describe, expect, it, vi } from "vitest";
import { handleEventCancelled } from "../lib/eventCancelledHandler.js";
import type { InboundMessage } from "../lib/rabbitConsumer.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

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
  venues?: { id: number; name: string; staff_id: string | null }[];
  updateError?: boolean;
  venueError?: boolean;
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
      { id: 1, name: "Grand Ballroom", staff_id: "VENUE-0001" },
      { id: 2, name: "Side Hall", staff_id: null },
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
  const venuesSelect = vi.fn().mockReturnValue({ in: venuesIn });

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "venue_bookings") return { update };
      if (table === "venues") return { select: venuesSelect };
      throw new Error(`unexpected table ${table}`);
    }),
  };

  return { supabase: supabase as any, update, updateEq, updateIn, venuesSelect, venuesIn };
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
});
