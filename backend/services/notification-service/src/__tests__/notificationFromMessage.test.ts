import { describe, expect, it, vi } from "vitest";
import { handleInboundMessage } from "../lib/notificationFromMessage.js";
import type { InboundMessage } from "../lib/rabbitConsumer.js";

/** A supabase-js style query: every filter returns the query, and awaiting it yields `result`. */
function query(result: Record<string, unknown>) {
  const q: Record<string, any> = {};
  for (const method of ["select", "eq", "limit"]) q[method] = vi.fn(() => q);
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

function buildMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "11111111-1111-1111-1111-111111111111",
    type: "booking.withdrawn",
    occurredAt: "2026-10-10T08:15:00Z",
    publisher: "venue-service",
    actorId: "COORD-0003",
    eventId: 7,
    recipients: { userIds: ["VEN-0001"], roles: [] },
    data: { venueName: "Auditorium A", reason: "event_cancelled" },
    ...overrides,
  };
}

function buildSupabase(options: { existing?: unknown[]; insertError?: unknown } = {}) {
  const existingQuery = query({ data: options.existing ?? [], error: null });
  const insert = vi.fn().mockResolvedValue({ error: options.insertError ?? null });
  const supabase = {
    from: vi.fn(() => ({ select: existingQuery.select, insert })),
  };
  return { supabase: supabase as any, existingQuery, insert };
}

describe("handleInboundMessage", () => {
  it("inserts one row per direct userId recipient", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn().mockResolvedValue([]);

    await handleInboundMessage(buildMsg(), { supabase, resolveRoleUserIds });

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "VEN-0001",
        event_id: 7,
        message_id: "11111111-1111-1111-1111-111111111111",
        type: "booking.withdrawn",
        actor_id: "COORD-0003",
        occurred_at: "2026-10-10T08:15:00Z",
      }),
    ]);
  });

  it("is a no-op when the messageId was already recorded (M5)", async () => {
    const { supabase, insert } = buildSupabase({ existing: [{ id: 1 }] });
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(buildMsg(), { supabase, resolveRoleUserIds });

    expect(insert).not.toHaveBeenCalled();
  });

  it("resolves recipients.roles via the injected dependency", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn().mockResolvedValue(["LEAD-0001"]);

    await handleInboundMessage(buildMsg({ recipients: { userIds: [], roles: ["coordinator_lead"] } }), {
      supabase,
      resolveRoleUserIds,
    });

    expect(resolveRoleUserIds).toHaveBeenCalledWith("coordinator_lead");
    expect(insert).toHaveBeenCalledWith([expect.objectContaining({ recipient_id: "LEAD-0001" })]);
  });

  it("logs and skips an unrecognized type without inserting or throwing", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      handleInboundMessage(buildMsg({ type: "something.unknown" }), { supabase, resolveRoleUserIds }),
    ).resolves.toBeUndefined();

    expect(insert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("renders different text per recipient for coordinator.assigned (the REST-to-broker migration)", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "coordinator.assigned",
        eventId: 7,
        recipients: { userIds: ["COORD-0002", "ORG-0001"], roles: [] },
        data: { eventName: "Nut Festival", coordinatorId: "COORD-0002", coordinatorName: "Coordinator Two", organiserId: "ORG-0001" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "COORD-0002", title: "New event assigned to you" }),
      expect.objectContaining({ recipient_id: "ORG-0001", title: "Your event has a coordinator" }),
    ]);
  });

  it("renders the leads' notification for request.submitted", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "request.submitted",
        eventId: 9,
        recipients: { userIds: ["LEAD-0001"], roles: [] },
        data: { eventName: "Nut Festival" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "LEAD-0001", title: "New request in the unassigned queue" }),
    ]);
  });

  it("renders different text per recipient for coordinator.reassigned", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "coordinator.reassigned",
        eventId: 7,
        recipients: { userIds: ["ORG-0001", "COORD-0001", "COORD-0002"], roles: [] },
        data: {
          eventName: "Nut Festival",
          organiserId: "ORG-0001",
          newCoordinatorId: "COORD-0002",
          newCoordinatorName: "Coordinator Two",
          previousCoordinatorId: "COORD-0001",
          previousCoordinatorName: "Coordinator One",
        },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "ORG-0001", title: "Your event has a new coordinator" }),
      expect.objectContaining({ recipient_id: "COORD-0001", title: "Event reassigned" }),
      expect.objectContaining({ recipient_id: "COORD-0002", title: "Event reassigned to you" }),
    ]);
  });

  it("renders the approved outcome for safety.decided", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "safety.decided",
        eventId: 7,
        recipients: { userIds: ["COORD-0001", "ORG-0001"], roles: [] },
        data: { outcome: "approved", eventName: "Nut Festival" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "COORD-0001", title: "Safety review approved" }),
      expect.objectContaining({ recipient_id: "ORG-0001", title: "Safety review approved" }),
    ]);
  });

  it("renders the rejected outcome for safety.decided", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "safety.decided",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { outcome: "rejected", reason: "Fire exit blocked by staging", eventName: "Spring Gala" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "COORD-0001",
        title: "Safety review rejected",
        body: expect.stringContaining("Fire exit blocked by staging"),
      }),
    ]);
  });

  it("renders the changes_requested outcome for safety.decided", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "safety.decided",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: {
          outcome: "changes_requested",
          reason: "Seminar Room 3-01: Exits are blocked by the stage.",
          eventName: "Spring Gala",
        },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "COORD-0001",
        body: expect.stringContaining("Seminar Room 3-01: Exits are blocked by the stage."),
      }),
    ]);
  });

  it("tells the organiser's confirmation apart from the leads' notice for request.submitted", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "request.submitted",
        eventId: 9,
        recipients: { userIds: ["ORG-0001", "LEAD-0001"], roles: [] },
        data: { eventName: "Nut Festival", organiserId: "ORG-0001" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "ORG-0001", title: "Request submitted" }),
      expect.objectContaining({ recipient_id: "LEAD-0001", title: "New request in the unassigned queue" }),
    ]);
  });

  it("renders request.edited", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "request.edited",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { eventName: "Nut Festival" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([expect.objectContaining({ recipient_id: "COORD-0001", title: "Request edited" })]);
  });

  it("renders clarification.requested with the message", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "clarification.requested",
        eventId: 7,
        recipients: { userIds: ["ORG-0001"], roles: [] },
        data: { eventName: "Nut Festival", message: "What time will setup start?" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "ORG-0001",
        title: "Clarification requested",
        body: expect.stringContaining("What time will setup start?"),
      }),
    ]);
  });

  it("renders clarification.answered", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "clarification.answered",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { eventName: "Nut Festival" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "COORD-0001", title: "Organiser responded to your question" }),
    ]);
  });

  it("renders request.decided for both approved and rejected", async () => {
    const { supabase: approvedSupabase, insert: approvedInsert } = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "request.decided",
        eventId: 7,
        recipients: { userIds: ["ORG-0001"], roles: [] },
        data: { eventName: "Nut Festival", decision: "approved" },
      }),
      { supabase: approvedSupabase, resolveRoleUserIds: vi.fn() },
    );
    expect(approvedInsert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "ORG-0001", title: "Request approved" }),
    ]);

    const { supabase: rejectedSupabase, insert: rejectedInsert } = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "request.decided",
        eventId: 7,
        recipients: { userIds: ["ORG-0001"], roles: [] },
        data: { eventName: "Nut Festival", decision: "rejected", reason: "No venue available" },
      }),
      { supabase: rejectedSupabase, resolveRoleUserIds: vi.fn() },
    );
    expect(rejectedInsert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "ORG-0001",
        title: "Request rejected",
        body: expect.stringContaining("No venue available"),
      }),
    ]);
  });

  it("renders safety.submitted", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn().mockResolvedValue([]);

    await handleInboundMessage(
      buildMsg({
        type: "safety.submitted",
        eventId: 7,
        recipients: { userIds: ["ORG-0001"], roles: ["safety_officer"] },
        data: { eventName: "Nut Festival" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "ORG-0001", title: "Submitted for safety review" }),
    ]);
  });

  it("renders registration.confirmed", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "registration.confirmed",
        eventId: 7,
        recipients: { userIds: ["ATT-0001"], roles: [] },
        data: { eventName: "Nut Festival" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "ATT-0001", title: "Registration confirmed" }),
    ]);
  });

  it("renders registration.withdrawn, falling back to generic wording with no eventName", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "registration.withdrawn",
        eventId: 7,
        recipients: { userIds: ["ATT-0001"], roles: [] },
        data: {},
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "ATT-0001",
        title: "Registration withdrawn",
        body: "You have withdrawn your registration.",
      }),
    ]);
  });

  it("renders booking.requested", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "booking.requested",
        eventId: 7,
        recipients: { userIds: ["VEN-0001"], roles: [] },
        data: { eventName: "Nut Festival", venueName: "Grand Ballroom", when: "2026-11-10, 10:00–12:00" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "VEN-0001", title: "New booking request for Grand Ballroom" }),
    ]);
  });

  it.each([
    ["on_hold", "Grand Ballroom — booking on hold"],
    ["approved", "Grand Ballroom — booking approved"],
    ["rejected", "Grand Ballroom — booking rejected"],
    ["auto_rejected", "Venue request for Nut Festival was rejected"],
  ])("renders booking.decided for decision=%s", async (decision, title) => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "booking.decided",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { decision, reason: "no venue available", eventName: "Nut Festival", venueName: "Grand Ballroom" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([expect.objectContaining({ recipient_id: "COORD-0001", title })]);
  });

  it("renders hold.expired", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "hold.expired",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { eventName: "Nut Festival", venueName: "Grand Ballroom" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "COORD-0001", title: "Grand Ballroom — hold expired" }),
    ]);
  });

  it("renders hold.expiring with the expiry time", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "hold.expiring",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { eventName: "Nut Festival", venueName: "Grand Ballroom", expiresAt: "2026-01-01T06:00:00.000Z" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "COORD-0001",
        title: "Grand Ballroom — hold expiring soon",
        body: expect.stringContaining("2026-01-01T06:00:00.000Z"),
      }),
    ]);
  });

  it("renders booking.replacement_required", async () => {
    const { supabase, insert } = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "booking.replacement_required",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { eventName: "Nut Festival", venueName: "Great Lawn", period: "13 Oct 2026 (all day)", reason: "Resurfacing", date: "13 Oct 2026" },
      }),
      { supabase, resolveRoleUserIds: vi.fn() },
    );
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "COORD-0001", title: "Alternative venue needed for Nut Festival" }),
    ]);
  });

  it("renders booking.unavailability_clash", async () => {
    const { supabase, insert } = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "booking.unavailability_clash",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { eventName: "Nut Festival", venueName: "Great Lawn", period: "13 Oct 2026", reason: "Resurfacing", date: "13 Oct 2026" },
      }),
      { supabase, resolveRoleUserIds: vi.fn() },
    );
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "COORD-0001", title: "Venue request for Nut Festival can't be met" }),
    ]);
  });

  it("renders booking.setup_conflict differently for the venue staff member and each coordinator", async () => {
    const { supabase, insert } = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "booking.setup_conflict",
        eventId: 7,
        recipients: { userIds: ["VEN-0001", "COORD-0001", "COORD-0002"], roles: [] },
        data: {
          venueName: "Great Lawn",
          venueStaffId: "VEN-0001",
          first: { eventName: "Nut Festival", window: "10:00–12:00" },
          second: { eventName: "Spring Gala", window: "11:30–13:00" },
          eventName: "Nut Festival",
          window: "10:00–12:00",
          otherEventName: "Spring Gala",
          otherEventId: 8,
          otherWindow: "11:30–13:00",
        },
      }),
      { supabase, resolveRoleUserIds: vi.fn() },
    );
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "VEN-0001", title: "Great Lawn's setup/turnaround change created a conflict" }),
      expect.objectContaining({ recipient_id: "COORD-0001", title: "Great Lawn booking now overlaps another" }),
      expect.objectContaining({ recipient_id: "COORD-0002", title: "Great Lawn booking now overlaps another" }),
    ]);
  });

  it("renders venue.capacity_reduced", async () => {
    const { supabase, insert } = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "venue.capacity_reduced",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { venueName: "Great Lawn", capacity: 100, eventName: "Nut Festival", date: "13 Oct 2026", expectedAttendance: 150 },
      }),
      { supabase, resolveRoleUserIds: vi.fn() },
    );
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "COORD-0001", title: "Great Lawn capacity reduced" }),
    ]);
  });

  it("renders equipment.requested", async () => {
    const { supabase, insert } = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "equipment.requested",
        eventId: 7,
        recipients: { userIds: ["TS-0001"], roles: [] },
        data: { eventName: "Nut Festival", itemCount: 2 },
      }),
      { supabase, resolveRoleUserIds: vi.fn() },
    );
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "TS-0001", title: "New equipment request", body: expect.stringContaining("2 equipment items") }),
    ]);
  });

  it("renders equipment.status_changed, including the partial-fulfilment note", async () => {
    const { supabase, insert } = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "equipment.status_changed",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { status: "Partially Fulfilled", note: "2 projectors short", eventName: "Nut Festival" },
      }),
      { supabase, resolveRoleUserIds: vi.fn() },
    );
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "COORD-0001", body: expect.stringContaining("2 projectors short") }),
    ]);
  });

  it("throws when the insert fails, so the caller nacks", async () => {
    const { supabase } = buildSupabase({ insertError: new Error("db down") });
    const resolveRoleUserIds = vi.fn().mockResolvedValue([]);

    await expect(handleInboundMessage(buildMsg(), { supabase, resolveRoleUserIds })).rejects.toThrow("db down");
  });
});
