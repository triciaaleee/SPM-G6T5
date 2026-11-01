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

function buildSupabase(options: { existing?: unknown[]; insertError?: unknown; lookup?: Record<string, unknown> } = {}) {
  const existingQuery = query(options.lookup ?? { data: options.existing ?? [], error: null });
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

  it("renders message.sent for the other party, same text either direction", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "message.sent",
        eventId: 7,
        actorId: "ORG-0001",
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { eventName: "Alumni Gala", preview: "What time does setup start?", senderRole: "organiser" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "COORD-0001",
        title: "New message about Alumni Gala",
        body: "What time does setup start?",
      }),
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

  it("renders change.requested with the affected fields", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "change.requested",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { eventName: "Nut Festival", changeRequestId: 55, fields: ["venue", "description"] },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "COORD-0001",
        title: "Change request raised",
        body: expect.stringContaining("venue, description"),
      }),
    ]);
  });

  it("renders change.withdrawn differently for the organiser and the coordinator", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "change.withdrawn",
        eventId: 7,
        actorId: "ORG-0001",
        recipients: { userIds: ["ORG-0001", "COORD-0001"], roles: [] },
        data: { eventName: "Nut Festival", changeRequestId: 55, fields: ["venue"] },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "ORG-0001",
        title: "Change request withdrawn",
        body: expect.stringContaining("Your requested change"),
      }),
      expect.objectContaining({
        recipient_id: "COORD-0001",
        title: "Change request withdrawn",
        body: expect.stringContaining("The organiser's requested change"),
      }),
    ]);
  });

  it("renders change.decided for an approval", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "change.decided",
        eventId: 7,
        recipients: { userIds: ["ORG-0001"], roles: [] },
        data: { eventName: "Nut Festival", outcome: "approved" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "ORG-0001",
        title: "Change request approved",
        body: expect.stringContaining("has been approved and applied"),
      }),
    ]);
  });

  it("renders change.decided for a partial approval — applied fields plus what's still awaiting review", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "change.decided",
        eventId: 7,
        recipients: { userIds: ["ORG-0001"], roles: [] },
        data: {
          eventName: "Nut Festival",
          outcome: "partially_approved",
          approvedFields: ["expectedAttendance"],
          remainingFields: ["startTime"],
        },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "ORG-0001",
        title: "Change request partially approved",
        body: expect.stringContaining("expectedAttendance"),
      }),
    ]);
    expect(insert.mock.calls[0][0][0].body).toContain("startTime");
    expect(insert.mock.calls[0][0][0].body).toContain("still awaiting your coordinator's review");
  });

  it("renders change.decided for a rejection with its reason", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "change.decided",
        eventId: 7,
        recipients: { userIds: ["ORG-0001"], roles: [] },
        data: { eventName: "Nut Festival", outcome: "rejected", reason: "Venue too small" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "ORG-0001",
        title: "Change request rejected",
        body: expect.stringContaining("Venue too small"),
      }),
    ]);
  });

  it("renders booking.flagged_for_rebooking for the venue's own staff", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "booking.flagged_for_rebooking",
        eventId: 7,
        recipients: { userIds: ["VEN-0001"], roles: [] },
        data: { venueName: "Seminar Room 3-01", reason: "Attendance change invalidated this booking" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "VEN-0001",
        title: "Seminar Room 3-01 — needs rebooking",
        body: expect.stringContaining("Attendance change invalidated this booking"),
      }),
    ]);
  });

  it("renders equipment.flagged_for_reassessment to the technical_support role", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn().mockResolvedValue(["TS-0001"]);

    await handleInboundMessage(
      buildMsg({
        type: "equipment.flagged_for_reassessment",
        eventId: 7,
        recipients: { userIds: [], roles: ["technical_support"] },
        data: { eventName: "Nut Festival", reason: "Equipment requirements changed" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(resolveRoleUserIds).toHaveBeenCalledWith("technical_support");
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "TS-0001",
        title: "Equipment request needs reassessment",
        body: expect.stringContaining("Equipment requirements changed"),
      }),
    ]);
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

  it("renders event.needs_review", async () => {
    const { supabase, insert } = buildSupabase();

    await handleInboundMessage(
      buildMsg({
        type: "event.needs_review",
        eventId: 7,
        recipients: { userIds: ["COORD-0001", "ORG-0001"], roles: [] },
        data: { eventName: "Nut Festival", reason: "Great Lawn is unavailable (Floor resurfacing)" },
      }),
      { supabase, resolveRoleUserIds: vi.fn() },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "COORD-0001", title: "Nut Festival needs review", link: "/events/7" }),
      expect.objectContaining({ recipient_id: "ORG-0001", title: "Nut Festival needs review" }),
    ]);
  });

  it("renders event.returned_to_planning", async () => {
    const { supabase, insert } = buildSupabase();

    await handleInboundMessage(
      buildMsg({
        type: "event.returned_to_planning",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { eventName: "Nut Festival", reason: "Great Lawn is unavailable" },
      }),
      { supabase, resolveRoleUserIds: vi.fn().mockResolvedValue([]) },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({ recipient_id: "COORD-0001", title: "Nut Festival returned to Planning" }),
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
      expect.objectContaining({
        recipient_id: "ATT-0001",
        title: "Registration confirmed",
        body: 'Your registration for "Nut Festival" is confirmed.',
        link: "/attendee/events/7",
      }),
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
        link: "/attendee/events/7",
      }),
    ]);
  });

  it("renders registration.cancelled_by_event, linking attendees to their own event page", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();

    await handleInboundMessage(
      buildMsg({
        type: "registration.cancelled_by_event",
        eventId: 7,
        recipients: { userIds: ["ATT-0001"], roles: [] },
        data: { eventName: "Spring Gala" },
      }),
      { supabase, resolveRoleUserIds },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "ATT-0001",
        title: "Event cancelled",
        body: 'Your registration for "Spring Gala" was cancelled because the event itself was cancelled.',
        link: "/attendee/events/7",
      }),
    ]);
  });

  it("renders equipment.amended, listing what changed and what was released, linking Technical Support to the event's requests", async () => {
    const { supabase, insert } = buildSupabase();

    await handleInboundMessage(
      buildMsg({
        type: "equipment.amended",
        eventId: 7,
        recipients: { userIds: [], roles: ["technical_support"] },
        data: {
          eventName: "Alumni Gala",
          released: 2,
          changes: [
            { kind: "quantity", equipmentType: "Projector", from: 5, to: 3, released: 2 },
            { kind: "added", equipmentType: "Microphone", quantity: 2, released: 0 },
            { kind: "removed", equipmentType: "Screen", quantity: 1, released: 0 },
            { kind: "type", fromType: "Speaker", equipmentType: "Mixer", from: 2, to: 1, released: 0 },
          ],
        },
      }),
      { supabase, resolveRoleUserIds: vi.fn().mockResolvedValue(["TS-0001"]) },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "TS-0001",
        title: "Equipment request amended",
        body: "Alumni Gala's equipment request was amended: Projector 5 → 3; Added Microphone ×2; Removed Screen; Speaker ×2 → Mixer ×1. 2 reserved items were released back to inventory.",
        link: "/equipment-requests/event/7",
      }),
    ]);
  });

  it("renders equipment.released for a coordinator cancelling one request, apart from an event cancellation", async () => {
    const coordinatorCancelled = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "equipment.released",
        eventId: 7,
        recipients: { userIds: [], roles: ["technical_support"] },
        data: {
          eventName: "Alumni Gala",
          reason: "coordinator_cancelled",
          released: [{ equipmentType: "Projector", quantity: 3 }],
        },
      }),
      { supabase: coordinatorCancelled.supabase, resolveRoleUserIds: vi.fn().mockResolvedValue(["TS-0001"]) },
    );
    expect(coordinatorCancelled.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Equipment request cancelled",
        body: "Alumni Gala's equipment request was cancelled by its coordinator. Released back to inventory: 3× Projector.",
        link: "/equipment-requests",
      }),
    ]);

    const eventCancelled = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "equipment.released",
        eventId: 7,
        recipients: { userIds: [], roles: ["technical_support"] },
        data: { eventName: "Alumni Gala", reason: "event_cancelled" },
      }),
      { supabase: eventCancelled.supabase, resolveRoleUserIds: vi.fn().mockResolvedValue(["TS-0001"]) },
    );
    expect(eventCancelled.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Equipment reservations released",
        link: "/equipment-requests/event/7",
      }),
    ]);
  });

  it("says a rejected event's equipment was released because it was rejected", async () => {
    const { supabase, insert } = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "equipment.released",
        eventId: 7,
        recipients: { userIds: [], roles: ["technical_support"] },
        data: { eventName: "Alumni Gala", reason: "event_rejected" },
      }),
      { supabase, resolveRoleUserIds: vi.fn().mockResolvedValue(["TS-0001"]) },
    );
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Equipment reservations released",
        body: "Alumni Gala was rejected, so its equipment reservations were released back to inventory.",
        link: "/equipment-requests/event/7",
      }),
    ]);
  });

  it("says a rejected event's venue booking was released because it was rejected", async () => {
    const { supabase, insert } = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "booking.withdrawn",
        data: { venueName: "Auditorium A", eventName: "Alumni Gala", reason: "event_rejected" },
      }),
      { supabase, resolveRoleUserIds: vi.fn().mockResolvedValue([]) },
    );
    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Auditorium A — booking released",
        body: "Alumni Gala was rejected, so its booking for Auditorium A was released and the venue is free again.",
      }),
    ]);
  });

  it("renders equipment.reservation_clash with the event page for the coordinator and the request for Technical Support", async () => {
    const { supabase, insert } = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "equipment.reservation_clash",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: ["technical_support"] },
        data: { eventName: "Alumni Gala", coordinatorId: "COORD-0001", units: 2 },
      }),
      { supabase, resolveRoleUserIds: vi.fn().mockResolvedValue(["TS-0001"]) },
    );

    expect(insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "COORD-0001",
        title: "Reserved equipment clashes after a reschedule",
        body: "Alumni Gala was rescheduled. 2 reserved equipment units now clash with another event's booking or an out-of-use period. Technical Support will need to arrange a replacement.",
        link: "/events/7",
      }),
      expect.objectContaining({ recipient_id: "TS-0001", link: "/equipment-requests/event/7" }),
    ]);
  });

  it("renders equipment.unusable for the coordinator, with and without an end date (E5-5 AC2)", async () => {
    const dated = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "equipment.unusable",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: {
          eventName: "Alumni Gala",
          equipmentType: "Projector",
          reason: "Damaged",
          startDate: "2026-11-03",
          endDate: "2026-11-07",
        },
      }),
      { supabase: dated.supabase, resolveRoleUserIds: vi.fn() },
    );
    expect(dated.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "COORD-0001",
        title: "Reserved equipment unavailable",
        body: "Projector reserved for Alumni Gala is damaged from 3 Nov 2026 to 7 Nov 2026. Technical Support will need to arrange a replacement.",
        link: "/events/7",
      }),
    ]);

    const openEnded = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "equipment.unusable",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: {
          eventName: "Alumni Gala",
          equipmentType: "Projector",
          reason: "Under Maintenance",
          startDate: "2026-11-03",
          endDate: null,
        },
      }),
      { supabase: openEnded.supabase, resolveRoleUserIds: vi.fn() },
    );
    expect(openEnded.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        body: "Projector reserved for Alumni Gala is under maintenance from 3 Nov 2026 until further notice. Technical Support will need to arrange a replacement.",
      }),
    ]);

    const several = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "equipment.unusable",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: {
          eventName: "Alumni Gala",
          equipmentType: "Projector",
          quantity: 2,
          reason: "Damaged",
          startDate: "2026-11-03",
          endDate: "2026-11-07",
        },
      }),
      { supabase: several.supabase, resolveRoleUserIds: vi.fn() },
    );
    expect(several.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        body: "2 Projector units reserved for Alumni Gala are damaged from 3 Nov 2026 to 7 Nov 2026. Technical Support will need to arrange a replacement.",
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
        body: expect.stringContaining("1 Jan 2026, 2:00 pm"),
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

  it("renders booking.invalidated_by_edit for the coordinator, differently for a flagged and a pending booking", async () => {
    const flagged = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "booking.invalidated_by_edit",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { eventName: "Alumni Gala", venueName: "Grand Ballroom", reason: "Grand Ballroom is unavailable on 2099-02-02 (all day): Renovation", status: "Replacement Required" },
      }),
      { supabase: flagged.supabase, resolveRoleUserIds: vi.fn() },
    );
    expect(flagged.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        recipient_id: "COORD-0001",
        title: "Venue booking needs a replacement",
        body: expect.stringContaining("The booking was flagged, so find a replacement venue."),
        link: "/events/7",
      }),
    ]);

    const pending = buildSupabase();
    await handleInboundMessage(
      buildMsg({
        type: "booking.invalidated_by_edit",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: [] },
        data: { eventName: "Alumni Gala", venueName: "Side Hall", reason: "Side Hall holds 40, fewer than the event's 80 expected attendees", status: "Requested" },
      }),
      { supabase: pending.supabase, resolveRoleUserIds: vi.fn() },
    );
    expect(pending.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        title: "Venue booking no longer fits",
        body: expect.stringContaining("its requested booking at Side Hall no longer fits"),
      }),
    ]);
  });

  it("skips event.attendance_changed quietly too", async () => {
    const { supabase, insert } = buildSupabase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleInboundMessage(buildMsg({ type: "event.attendance_changed" }), { supabase, resolveRoleUserIds: vi.fn() });

    expect(insert).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips event.rescheduled quietly: other services act on it, nobody is notified", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleInboundMessage(buildMsg({ type: "event.rescheduled", recipients: { userIds: ["ORG-0001"], roles: ["coordinator_lead"] } }), {
      supabase,
      resolveRoleUserIds,
    });

    expect(supabase.from).not.toHaveBeenCalled();
    expect(resolveRoleUserIds).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("skips event.rejected quietly: the services holding the event's arrangements act on it, nobody is notified", async () => {
    const { supabase, insert } = buildSupabase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleInboundMessage(buildMsg({ type: "event.rejected", recipients: { userIds: [], roles: [] } }), {
      supabase,
      resolveRoleUserIds: vi.fn(),
    });

    expect(insert).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("throws when the insert fails, so the caller nacks", async () => {
    const { supabase } = buildSupabase({ insertError: new Error("db down") });
    const resolveRoleUserIds = vi.fn().mockResolvedValue([]);

    await expect(handleInboundMessage(buildMsg(), { supabase, resolveRoleUserIds })).rejects.toThrow("db down");
  });

  it("writes every column of the row", async () => {
    const { supabase, insert } = buildSupabase();

    await handleInboundMessage(buildMsg(), { supabase, resolveRoleUserIds: vi.fn() });

    expect(supabase.from.mock.calls).toEqual([["notifications"], ["notifications"]]);
    expect(insert).toHaveBeenCalledWith([
      {
        recipient_id: "VEN-0001",
        type: "booking.withdrawn",
        title: "Auditorium A — booking released",
        body: "your event was cancelled, so its booking for Auditorium A was released and the venue is free again.",
        link: "/events/7",
        event_id: 7,
        message_id: "11111111-1111-1111-1111-111111111111",
        actor_id: "COORD-0003",
        occurred_at: "2026-10-10T08:15:00Z",
      },
    ]);
  });

  it("looks a redelivered message up by its messageId", async () => {
    const { supabase, existingQuery } = buildSupabase();

    await handleInboundMessage(buildMsg(), { supabase, resolveRoleUserIds: vi.fn() });

    expect(existingQuery.select).toHaveBeenCalledWith("id");
    expect(existingQuery.eq).toHaveBeenCalledWith("message_id", "11111111-1111-1111-1111-111111111111");
    expect(existingQuery.limit).toHaveBeenCalledWith(1);
  });

  it("throws when the dedupe lookup fails, so the caller nacks", async () => {
    const failure = { message: "lookup failed" };
    const { supabase, insert } = buildSupabase({ lookup: { data: null, error: failure } });

    await expect(handleInboundMessage(buildMsg(), { supabase, resolveRoleUserIds: vi.fn() })).rejects.toBe(failure);

    expect(insert).not.toHaveBeenCalled();
  });

  it("treats a lookup with no data as not yet recorded", async () => {
    const { supabase, insert } = buildSupabase({ lookup: { data: null, error: null } });

    await handleInboundMessage(buildMsg(), { supabase, resolveRoleUserIds: vi.fn() });

    expect(insert).toHaveBeenCalledOnce();
  });

  it("notifies someone only once when they are named directly and through a role", async () => {
    const { supabase, insert } = buildSupabase();
    const resolveRoleUserIds = vi.fn(async (role: string) => (role === "a" ? ["LEAD-1", "U-1"] : ["LEAD-1", "LEAD-2"]));

    await handleInboundMessage(buildMsg({ recipients: { userIds: ["U-1"], roles: ["a", "b"] } }), { supabase, resolveRoleUserIds });

    expect(insert.mock.calls[0][0].map((r: { recipient_id: string }) => r.recipient_id)).toEqual(["U-1", "LEAD-1", "LEAD-2"]);
  });

  it("inserts nothing and warns about nothing when a message has no recipients", async () => {
    const { supabase, insert } = buildSupabase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleInboundMessage(buildMsg({ recipients: { userIds: [], roles: ["nobody_holds_this"] } }), {
      supabase,
      resolveRoleUserIds: vi.fn().mockResolvedValue([]),
    });

    expect(insert).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("throws when a role lookup fails, so the message is dead-lettered instead of lost", async () => {
    const { supabase, insert } = buildSupabase();
    const failure = new Error("user-service returned 500");

    await expect(
      handleInboundMessage(buildMsg({ recipients: { userIds: ["U-1"], roles: ["coordinator_lead"] } }), {
        supabase,
        resolveRoleUserIds: vi.fn().mockRejectedValue(failure),
      }),
    ).rejects.toBe(failure);

    expect(insert).not.toHaveBeenCalled();
  });

  it("names the type it has no template for", async () => {
    const { supabase } = buildSupabase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleInboundMessage(buildMsg({ type: "something.unknown" }), { supabase, resolveRoleUserIds: vi.fn() });

    expect(warn).toHaveBeenCalledWith('notification-service: no template for message type "something.unknown", skipping');
    warn.mockRestore();
  });

  it("treats a type named after a built-in object property as having no template", async () => {
    const { supabase, insert } = buildSupabase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleInboundMessage(buildMsg({ type: "constructor" }), { supabase, resolveRoleUserIds: vi.fn() });

    expect(insert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it.each(["event.rescheduled", "event.attendance_changed", "event.rejected"])("doesn't even look up %s", async (type) => {
    const { supabase } = buildSupabase();
    await handleInboundMessage(buildMsg({ type }), { supabase, resolveRoleUserIds: vi.fn() });
    expect(supabase.from).not.toHaveBeenCalled();
  });
});
