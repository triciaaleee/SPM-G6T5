import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleEventEdited } from "../lib/planningEditReview.js";
import { handleMessage } from "../lib/handleMessage.js";
import type { InboundMessage } from "../lib/rabbitConsumer.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

// The handler has no end-user token: other events' schedules are read with an
// internal token (fetchVenueBookingInfoInternal) and the event is told about a
// flagged booking with reportArrangementsChanged. Both are mocked here.
const clients = vi.hoisted(() => ({
  fetchVenueBookingInfoInternal: vi.fn(),
  reportArrangementsChanged: vi.fn().mockResolvedValue(true),
}));
vi.mock("../lib/eventsClient.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/eventsClient.js")>();
  return {
    ...original,
    fetchVenueBookingInfoInternal: clients.fetchVenueBookingInfoInternal,
    reportArrangementsChanged: clients.reportArrangementsChanged,
  };
});

type Row = Record<string, any>;

/** A tiny in-memory supabase: eq / in / lte / gte filters, select, and update(...).eq(...).select().maybeSingle(). */
function buildSupabase(
  tables: Record<string, Row[]>,
  options: {
    failTable?: string;
    /** Tables whose reads answer with no data and no error. */
    nullTables?: string[];
    /** The update of a booking answers with an error. */
    updateError?: boolean;
  } = {},
) {
  const updates: { table: string; patch: Row; id: number }[] = [];
  const selects: { table: string; columns: string }[] = [];

  function query(table: string) {
    const filters: ((row: Row) => boolean)[] = [];
    let patch: Row | null = null;
    const matches = () => (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    const q: any = {
      select: vi.fn((columns: string) => { selects.push({ table, columns }); return q; }),
      update: vi.fn((p: Row) => { patch = p; return q; }),
      eq: vi.fn((field: string, value: unknown) => { filters.push((r) => r[field] === value); return q; }),
      in: vi.fn((field: string, values: unknown[]) => { filters.push((r) => values.includes(r[field])); return q; }),
      lte: vi.fn((field: string, value: string) => { filters.push((r) => r[field] <= value); return q; }),
      gte: vi.fn((field: string, value: string) => { filters.push((r) => r[field] >= value); return q; }),
      maybeSingle: vi.fn(async () => {
        if (options.updateError && patch) return { data: null, error: { message: "boom" } };
        const [row] = matches();
        if (patch && row) {
          Object.assign(row, patch);
          updates.push({ table, patch, id: row.id });
        }
        return { data: row ? { id: row.id } : null, error: null };
      }),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        Promise.resolve(
          options.failTable === table
            ? { data: null, error: { message: "boom" } }
            : options.nullTables?.includes(table)
              ? { data: null, error: null }
              : { data: matches().map((r) => ({ ...r })), error: null },
        ).then(resolve, reject),
    };
    return q;
  }

  return { supabase: { from: vi.fn((table: string) => query(table)) } as any, updates, selects, tables };
}

const NEW_DAY = "2099-02-02";

function buildMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "22222222-2222-2222-2222-222222222222",
    type: "event.rescheduled",
    occurredAt: "2026-10-10T08:15:00Z",
    publisher: "events-service",
    actorId: "ORG-0001",
    eventId: 7,
    recipients: { userIds: [], roles: [] },
    data: { eventName: "Spring Gala", coordinatorId: "COORD-0001", proposedDate: NEW_DAY, startTime: "13:00", endTime: "15:00" },
    ...overrides,
  };
}

const attendanceMsg = (expectedAttendance: number | null, overrides: Partial<InboundMessage> = {}) =>
  buildMsg({
    type: "event.attendance_changed",
    data: { eventName: "Spring Gala", coordinatorId: "COORD-0001", expectedAttendance },
    ...overrides,
  });

function venue(overrides: Row = {}): Row {
  return { id: 1, name: "Grand Ballroom", location: "Block A", capacity: 100, setup_minutes: 0, turnaround_minutes: 0, ...overrides };
}

function booking(overrides: Row = {}): Row {
  return { id: 900, venue_id: 1, event_id: 7, status: "Approved", hold_expires_at: null, purpose: null, headcount: null, ...overrides };
}

const blockOut = (overrides: Row = {}): Row => ({
  id: 1, venue_id: 1, start_date: NEW_DAY, end_date: NEW_DAY, all_day: true, start_time: null, end_time: null, reason: "Renovation", ...overrides,
});

const publish = vi.fn().mockResolvedValue(true);

beforeEach(() => {
  clients.fetchVenueBookingInfoInternal.mockReset().mockResolvedValue({ status: "ok", events: [] });
  clients.reportArrangementsChanged.mockReset().mockResolvedValue(true);
  publish.mockReset().mockResolvedValue(true);
  setPublisherForTest({ publish });
});

const invalidated = () => publish.mock.calls.map((c) => c[0]).filter((m) => m.type === "booking.invalidated_by_edit");

describe("handleEventEdited: a schedule edit", () => {
  it("flags an Approved booking whose venue is blocked out on the new day, and tells the coordinator and events-service", async () => {
    const { supabase, updates } = buildSupabase({ venue_bookings: [booking()], venues: [venue()], venue_unavailability: [blockOut()] });

    await handleEventEdited(buildMsg(), { supabase });

    expect(updates).toEqual([
      { table: "venue_bookings", id: 900, patch: expect.objectContaining({ status: "Replacement Required", decided_by: null, decision_reason: expect.stringContaining("Renovation") }) },
    ]);
    expect(invalidated()).toEqual([
      expect.objectContaining({
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: expect.objectContaining({ venueName: "Grand Ballroom", status: "Replacement Required", reason: expect.stringContaining("is unavailable") }),
      }),
    ]);
    expect(clients.reportArrangementsChanged).toHaveBeenCalledTimes(1);
    expect(clients.reportArrangementsChanged).toHaveBeenCalledWith(7, "1 venue booking no longer fits after the event was edited");
  });

  it("flags an Approved booking that now overlaps another event's booking of the venue", async () => {
    const { supabase, updates } = buildSupabase({
      venue_bookings: [booking(), booking({ id: 950, event_id: 8, status: "Approved" })],
      venues: [venue()],
      venue_unavailability: [],
    });
    clients.fetchVenueBookingInfoInternal.mockResolvedValue({
      status: "ok",
      events: [{ id: 8, proposedDate: NEW_DAY, startTime: "14:00", endTime: "16:00" }],
    });

    await handleEventEdited(buildMsg(), { supabase });

    expect(updates).toHaveLength(1);
    expect(invalidated()[0].data.reason).toContain("Another booking holds Grand Ballroom");
  });

  it("counts the venue's setup and turnaround time when looking for a clash", async () => {
    const { supabase, updates } = buildSupabase({
      venue_bookings: [booking(), booking({ id: 950, event_id: 8, status: "Approved" })],
      venues: [venue({ setup_minutes: 60, turnaround_minutes: 60 })],
      venue_unavailability: [],
    });
    // The new time is 13:00-15:00, so with 60 minutes either side the venue is tied up 12:00-16:00.
    // The other event (15:30-17:00, itself padded to 14:30-18:00) only overlaps once the padding is counted.
    clients.fetchVenueBookingInfoInternal.mockResolvedValue({
      status: "ok",
      events: [{ id: 8, proposedDate: NEW_DAY, startTime: "15:30", endTime: "17:00" }],
    });

    await handleEventEdited(buildMsg(), { supabase });

    expect(updates).toHaveLength(1);
  });

  it("does nothing when the booking still fits", async () => {
    const { supabase, updates } = buildSupabase({
      venue_bookings: [booking(), booking({ id: 950, event_id: 8, status: "Approved" })],
      venues: [venue()],
      venue_unavailability: [blockOut({ start_date: "2099-03-01", end_date: "2099-03-02" })],
    });
    clients.fetchVenueBookingInfoInternal.mockResolvedValue({
      status: "ok",
      events: [{ id: 8, proposedDate: NEW_DAY, startTime: "15:00", endTime: "17:00" }],
    });

    await handleEventEdited(buildMsg(), { supabase });

    expect(updates).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    expect(clients.reportArrangementsChanged).not.toHaveBeenCalled();
  });

  it("never counts the event's own other booking of the same venue as a clash", async () => {
    const { supabase, updates } = buildSupabase({
      venue_bookings: [booking(), booking({ id: 901, status: "Approved", purpose: "Breakout", headcount: 20 })],
      venues: [venue()],
      venue_unavailability: [],
    });
    clients.fetchVenueBookingInfoInternal.mockResolvedValue({
      status: "ok",
      events: [{ id: 7, proposedDate: NEW_DAY, startTime: "13:00", endTime: "15:00" }],
    });

    await handleEventEdited(buildMsg(), { supabase });

    expect(updates).toHaveLength(0);
  });

  it("reports a Requested booking without changing its status or calling events-service", async () => {
    const { supabase, updates } = buildSupabase({
      venue_bookings: [booking({ id: 901, status: "Requested" })],
      venues: [venue()],
      venue_unavailability: [blockOut()],
    });

    await handleEventEdited(buildMsg(), { supabase });

    expect(updates).toHaveLength(0);
    expect(invalidated()).toEqual([expect.objectContaining({ data: expect.objectContaining({ status: "Requested" }) })]);
    expect(clients.reportArrangementsChanged).not.toHaveBeenCalled();
  });

  it("reviews an unexpired On Hold booking but ignores an expired hold and every ended status", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const { supabase } = buildSupabase({
      venue_bookings: [
        booking({ id: 910, status: "On Hold", hold_expires_at: future }),
        booking({ id: 911, status: "On Hold", hold_expires_at: past }),
        booking({ id: 912, status: "Rejected" }),
        booking({ id: 913, status: "Withdrawn" }),
        booking({ id: 914, status: "Expired" }),
        booking({ id: 915, status: "Cancelled" }),
        booking({ id: 916, status: "Replacement Required" }),
      ],
      venues: [venue()],
      venue_unavailability: [blockOut()],
    });

    await handleEventEdited(buildMsg(), { supabase });

    expect(invalidated().map((m) => m.data.status)).toEqual(["On Hold"]);
  });

  it("does nothing when the new schedule has no usable date", async () => {
    const { supabase, updates } = buildSupabase({ venue_bookings: [booking()], venues: [venue()], venue_unavailability: [blockOut()] });

    await handleEventEdited(buildMsg({ data: { eventName: "x", coordinatorId: "COORD-0001", proposedDate: null } }), { supabase });

    expect(updates).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does nothing for an event with no active bookings", async () => {
    const { supabase } = buildSupabase({ venue_bookings: [booking({ status: "Withdrawn" })], venues: [venue()], venue_unavailability: [blockOut()] });

    await handleEventEdited(buildMsg(), { supabase });

    expect(publish).not.toHaveBeenCalled();
  });
});

describe("handleEventEdited: an attendance edit", () => {
  it("flags an Approved booking meant for the whole attendance at a venue that is now too small", async () => {
    const { supabase, updates } = buildSupabase({ venue_bookings: [booking()], venues: [venue({ capacity: 100 })] });

    await handleEventEdited(attendanceMsg(150), { supabase });

    expect(updates).toEqual([
      { table: "venue_bookings", id: 900, patch: expect.objectContaining({ status: "Replacement Required", decision_reason: "Grand Ballroom holds 100, fewer than the event's 150 expected attendees" }) },
    ]);
    expect(clients.reportArrangementsChanged).toHaveBeenCalledTimes(1);
  });

  it("flags a main-programme booking even if it has a headcount", async () => {
    const { supabase, updates } = buildSupabase({ venue_bookings: [booking({ purpose: "Main programme", headcount: 90 })], venues: [venue({ capacity: 100 })] });

    await handleEventEdited(attendanceMsg(150), { supabase });

    expect(updates).toHaveLength(1);
  });

  it("leaves a small breakout room alone", async () => {
    const { supabase, updates } = buildSupabase({
      venue_bookings: [booking({ purpose: "Breakout", headcount: 30 })],
      venues: [venue({ capacity: 40 })],
    });

    await handleEventEdited(attendanceMsg(500), { supabase });

    expect(updates).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does nothing when the venue still holds the new attendance, or the message has no number", async () => {
    const { supabase, updates } = buildSupabase({ venue_bookings: [booking()], venues: [venue({ capacity: 100 })] });

    await handleEventEdited(attendanceMsg(100), { supabase });
    await handleEventEdited(attendanceMsg(null), { supabase });

    expect(updates).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not check the schedule for an attendance edit", async () => {
    const { supabase } = buildSupabase({ venue_bookings: [booking()], venues: [venue({ capacity: 500 })], venue_unavailability: [blockOut()] });

    await handleEventEdited(attendanceMsg(50), { supabase });

    expect(publish).not.toHaveBeenCalled();
    expect(clients.fetchVenueBookingInfoInternal).not.toHaveBeenCalled();
  });
});

describe("handleEventEdited: delivery", () => {
  it("is a no-op the second time, because a flagged booking is no longer Approved", async () => {
    const { supabase, updates } = buildSupabase({ venue_bookings: [booking()], venues: [venue()], venue_unavailability: [blockOut()] });

    await handleEventEdited(buildMsg(), { supabase });
    await handleEventEdited(buildMsg(), { supabase });

    expect(updates).toHaveLength(1);
    expect(invalidated()).toHaveLength(1);
    expect(clients.reportArrangementsChanged).toHaveBeenCalledTimes(1);
  });

  it("gives a pending booking's notification the same id when redelivered, so it is recorded once", async () => {
    const { supabase } = buildSupabase({ venue_bookings: [booking({ status: "Requested" })], venues: [venue()], venue_unavailability: [blockOut()] });

    await handleEventEdited(buildMsg(), { supabase });
    await handleEventEdited(buildMsg(), { supabase });
    await handleEventEdited(buildMsg({ messageId: "33333333-3333-3333-3333-333333333333" }), { supabase });

    const ids = publish.mock.calls.map((c) => c[0].messageId);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("notifies the coordinators' lead when the event has no coordinator", async () => {
    const { supabase } = buildSupabase({ venue_bookings: [booking()], venues: [venue()], venue_unavailability: [blockOut()] });

    await handleEventEdited(buildMsg({ data: { eventName: "Spring Gala", coordinatorId: null, proposedDate: NEW_DAY, startTime: "13:00", endTime: "15:00" } }), { supabase });

    expect(invalidated()[0].recipients).toEqual({ userIds: [], roles: ["coordinator_lead"] });
  });

  it("leaves a booking alone when someone else decided it first", async () => {
    const rows = [booking()];
    const { supabase, updates } = buildSupabase({ venue_bookings: rows, venues: [venue()], venue_unavailability: [blockOut()] });
    // The review loads it as Approved, then the staff withdraw it before the update lands.
    const originalFrom = supabase.from;
    let reads = 0;
    supabase.from = vi.fn((table: string) => {
      const q = originalFrom(table);
      if (table === "venue_bookings") {
        const originalUpdate = q.update;
        q.update = vi.fn((patch: Row) => { rows[0].status = "Withdrawn"; return originalUpdate(patch); });
        reads += 1;
      }
      return q;
    });

    await handleEventEdited(buildMsg(), { supabase });

    expect(reads).toBeGreaterThan(0);
    expect(updates).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    expect(clients.reportArrangementsChanged).not.toHaveBeenCalled();
  });

  it("throws when events-service can't be asked, so the message is retried via the dead-letter queue", async () => {
    const { supabase } = buildSupabase({
      venue_bookings: [booking(), booking({ id: 950, event_id: 8, status: "Approved" })],
      venues: [venue()],
      venue_unavailability: [],
    });
    clients.fetchVenueBookingInfoInternal.mockResolvedValue({ status: "error" });

    await expect(handleEventEdited(buildMsg(), { supabase })).rejects.toThrow();
  });

  it("throws when the database can't be read", async () => {
    const { supabase } = buildSupabase({ venue_bookings: [booking()], venues: [venue()] }, { failTable: "venue_bookings" });

    await expect(handleEventEdited(buildMsg(), { supabase })).rejects.toEqual({ message: "boom" });
  });

  it("ignores a message with no event id", async () => {
    const { supabase } = buildSupabase({ venue_bookings: [booking()], venues: [venue()] });

    await handleEventEdited(buildMsg({ eventId: null }), { supabase });

    expect(supabase.from).not.toHaveBeenCalled();
  });
});

describe("handleEventEdited: edges", () => {
  it("does nothing when the bookings come back as no data", async () => {
    const { supabase, updates } = buildSupabase({ venue_bookings: [booking()], venues: [venue()] }, { nullTables: ["venue_bookings"] });

    await handleEventEdited(buildMsg(), { supabase });

    expect(updates).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalledWith("venues");
  });

  it("leaves a booking alone when its venue can't be found, even if the venue lookup returns no data", async () => {
    const { supabase, updates } = buildSupabase(
      { venue_bookings: [booking()], venues: [venue()], venue_unavailability: [blockOut()] },
      { nullTables: ["venues"] },
    );

    await handleEventEdited(buildMsg(), { supabase });

    expect(updates).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    expect(clients.reportArrangementsChanged).not.toHaveBeenCalled();
  });

  it("skips only the booking whose venue is missing and still reviews the others", async () => {
    const { supabase, updates } = buildSupabase({
      venue_bookings: [booking({ id: 901, venue_id: 2 }), booking()],
      venues: [venue()],
      venue_unavailability: [blockOut()],
    });

    await handleEventEdited(buildMsg(), { supabase });

    expect(updates.map((u) => u.id)).toEqual([900]);
    expect(invalidated()).toHaveLength(1);
  });

  it("throws when the venues can't be read", async () => {
    const { supabase } = buildSupabase({ venue_bookings: [booking()], venues: [venue()] }, { failTable: "venues" });

    await expect(handleEventEdited(buildMsg(), { supabase })).rejects.toMatchObject({ message: "boom" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("throws when the venue's block-out periods can't be read", async () => {
    const { supabase } = buildSupabase({ venue_bookings: [booking()], venues: [venue()] }, { failTable: "venue_unavailability" });

    await expect(handleEventEdited(buildMsg(), { supabase })).rejects.toThrow("Failed to check the venue's block-out periods");
    expect(publish).not.toHaveBeenCalled();
  });

  it("throws when flagging the booking fails, and tells nobody", async () => {
    const { supabase, updates } = buildSupabase(
      { venue_bookings: [booking()], venues: [venue()], venue_unavailability: [blockOut()] },
      { updateError: true },
    );

    await expect(handleEventEdited(buildMsg(), { supabase })).rejects.toMatchObject({ message: "boom" });
    expect(updates).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
    expect(clients.reportArrangementsChanged).not.toHaveBeenCalled();
  });

  it("tells events-service in the plural when several bookings were flagged", async () => {
    const { supabase, updates } = buildSupabase({
      venue_bookings: [booking(), booking({ id: 901, purpose: "Breakout", headcount: 20 })],
      venues: [venue()],
      venue_unavailability: [blockOut()],
    });

    await handleEventEdited(buildMsg(), { supabase });

    expect(updates).toHaveLength(2);
    expect(clients.reportArrangementsChanged).toHaveBeenCalledTimes(1);
    expect(clients.reportArrangementsChanged).toHaveBeenCalledWith(7, "2 venue bookings no longer fit after the event was edited");
  });

  it("names the event by its number when the message carries no name", async () => {
    const { supabase } = buildSupabase({ venue_bookings: [booking()], venues: [venue()], venue_unavailability: [blockOut()] });

    await handleEventEdited(
      buildMsg({ data: { coordinatorId: "COORD-0001", proposedDate: NEW_DAY, startTime: "13:00", endTime: "15:00" } }),
      { supabase },
    );

    expect(invalidated()[0].data.eventName).toBe("Event #7");
  });
});

describe("handleEventEdited: details the review depends on", () => {
  it("reads nothing at all for an attendance edit that carries no number", async () => {
    const { supabase } = buildSupabase({ venue_bookings: [booking()], venues: [venue({ capacity: 0 })] });

    await handleEventEdited(attendanceMsg(null), { supabase });

    expect(supabase.from).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("asks only for the booking's id back when it flags one", async () => {
    const { supabase, selects } = buildSupabase({ venue_bookings: [booking()], venues: [venue()], venue_unavailability: [blockOut()] });

    await handleEventEdited(buildMsg(), { supabase });

    expect(selects.filter((s) => s.table === "venue_bookings").map((s) => s.columns)).toContain("id");
  });

  it("gives each flagged booking its own notification id, the same one when the message is redelivered", async () => {
    const tables = () => ({
      venue_bookings: [booking(), booking({ id: 901, status: "Requested" })],
      venues: [venue()],
      venue_unavailability: [blockOut()],
    });
    await handleEventEdited(buildMsg(), { supabase: buildSupabase(tables()).supabase });
    const first = invalidated().map((m) => m.messageId);
    expect(first).toHaveLength(2);
    expect(first[0]).not.toBe(first[1]);
    expect(first[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    publish.mockClear();
    await handleEventEdited(buildMsg(), { supabase: buildSupabase(tables()).supabase });
    expect(invalidated().map((m) => m.messageId)).toEqual(first);
  });

  it("names the failure when another event's bookings can't be read", async () => {
    const { supabase } = buildSupabase({
      venue_bookings: [booking(), booking({ id: 950, event_id: 8, status: "Approved" })],
      venues: [venue()],
      venue_unavailability: [],
    });
    clients.fetchVenueBookingInfoInternal.mockResolvedValue({ status: "error" });

    await expect(handleEventEdited(buildMsg(), { supabase })).rejects.toThrow("Failed to check the venue's other bookings");
  });

  it("treats a booking with a headcount but no purpose as meant for the whole attendance", async () => {
    const { supabase, updates } = buildSupabase({ venue_bookings: [booking({ purpose: null, headcount: 20 })], venues: [venue({ capacity: 100 })] });

    await handleEventEdited(attendanceMsg(150), { supabase });

    expect(updates).toHaveLength(1);
  });

  it("treats a booking with a purpose but no headcount as meant for the whole attendance", async () => {
    const { supabase, updates } = buildSupabase({ venue_bookings: [booking({ purpose: "Breakout", headcount: null })], venues: [venue({ capacity: 100 })] });

    await handleEventEdited(attendanceMsg(150), { supabase });

    expect(updates).toHaveLength(1);
  });
});

describe("handleMessage", () => {
  it("sends both edit messages to the review", async () => {
    const { supabase } = buildSupabase({ venue_bookings: [booking()], venues: [venue({ capacity: 10 })], venue_unavailability: [blockOut()] });

    await handleMessage(buildMsg(), { supabase });
    expect(supabase.from).toHaveBeenCalledWith("venue_bookings");

    supabase.from.mockClear();
    await handleMessage(attendanceMsg(50), { supabase });
    expect(supabase.from).toHaveBeenCalledWith("venue_bookings");
  });

  it("skips a type it has no handler for", async () => {
    const { supabase } = buildSupabase({});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleMessage(buildMsg({ type: "something.else" }), { supabase });

    expect(supabase.from).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('venue-service: no handler for "something.else", skipping');
    warn.mockRestore();
  });
});
