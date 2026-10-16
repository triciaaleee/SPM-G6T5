import { describe, expect, it, vi, beforeEach } from "vitest";
import { sweepExpiringHolds } from "../lib/bookingDecisions.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

const clients = vi.hoisted(() => ({ fetchVenueBookingInfoInternal: vi.fn() }));
vi.mock("../lib/eventsClient.js", () => ({ fetchVenueBookingInfoInternal: clients.fetchVenueBookingInfoInternal }));

const HOLD = {
  id: 10,
  venue_id: 1,
  event_id: 7,
  status: "On Hold",
  hold_expires_at: "2026-01-01T06:00:00.000Z",
  decision_reason: null,
  decided_by: null,
  decided_at: null,
};

const VENUE = { id: 1, name: "Grand Ballroom", location: "Central Campus", setup_minutes: 0, turnaround_minutes: 0 };

function buildSupabase(options: { holds?: Record<string, unknown>[]; venues?: Record<string, unknown>[] } = {}) {
  const holds = options.holds ?? [HOLD];
  const venues = options.venues ?? [VENUE];

  const lte = vi.fn().mockResolvedValue({ data: holds, error: null });
  const gt = vi.fn().mockReturnValue({ lte });
  const is = vi.fn().mockReturnValue({ gt });
  const eq = vi.fn().mockReturnValue({ is });
  const holdsSelect = vi.fn().mockReturnValue({ eq });

  const venuesIn = vi.fn().mockResolvedValue({ data: venues, error: null });
  const venuesSelect = vi.fn().mockReturnValue({ in: venuesIn });

  const updateIn = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn().mockReturnValue({ in: updateIn });

  let venueBookingsCalls = 0;
  const from = vi.fn((table: string) => {
    if (table === "venues") return { select: venuesSelect };
    if (table === "venue_bookings") {
      venueBookingsCalls += 1;
      return venueBookingsCalls === 1 ? { select: holdsSelect } : { update };
    }
    throw new Error(`unexpected table ${table}`);
  });

  return { from, holdsSelect, eq, is, gt, lte, update, updateIn } as any;
}

beforeEach(() => {
  clients.fetchVenueBookingInfoInternal.mockReset().mockResolvedValue({
    status: "ok",
    events: [{ id: 7, name: "Nut Festival", coordinatorId: "COORD-0007" }],
  });
});

describe("sweepExpiringHolds", () => {
  it("publishes hold.expiring for a hold inside the warning window and stamps it", async () => {
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });
    const supabase = buildSupabase();

    await sweepExpiringHolds(supabase);

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "hold.expiring",
        eventId: 7,
        recipients: { userIds: ["COORD-0007"], roles: [] },
        data: expect.objectContaining({ venueName: "Grand Ballroom", expiresAt: HOLD.hold_expires_at }),
      }),
    );
    expect(supabase.update).toHaveBeenCalledWith(expect.objectContaining({ expiry_warning_sent_at: expect.any(String) }));
    expect(supabase.updateIn).toHaveBeenCalledWith("id", [10]);
  });

  it("does nothing when no holds are in the warning window", async () => {
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });
    const supabase = buildSupabase({ holds: [] });

    await sweepExpiringHolds(supabase);

    expect(publish).not.toHaveBeenCalled();
    expect(supabase.update).not.toHaveBeenCalled();
  });

  it("skips a booking whose coordinator can't be resolved, but still stamps it", async () => {
    clients.fetchVenueBookingInfoInternal.mockResolvedValue({ status: "ok", events: [] });
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });
    const supabase = buildSupabase();

    await sweepExpiringHolds(supabase);

    expect(publish).not.toHaveBeenCalled();
    expect(supabase.updateIn).toHaveBeenCalledWith("id", [10]);
  });
});
