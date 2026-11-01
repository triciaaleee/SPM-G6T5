import { describe, expect, it, vi } from "vitest";
import { handleEventCancelled } from "../lib/eventCancelledHandler.js";
import { handleEventRejected } from "../lib/eventRejectedHandler.js";
import { handleMessage } from "../lib/handleMessage.js";
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

function buildSupabase(options: {
  bookings?: { id: number }[];
  rpcError?: { message: string } | null;
} = {}) {
  const bookings = options.bookings ?? [{ id: 1 }];

  const bookingsLimit = vi.fn().mockResolvedValue({ data: bookings, error: null });
  const bookingsStatusEq = vi.fn().mockReturnValue({ limit: bookingsLimit });
  const bookingsEq = vi.fn().mockReturnValue({ eq: bookingsStatusEq });
  const bookingsSelect = vi.fn().mockReturnValue({ eq: bookingsEq });

  const rpc = vi.fn().mockResolvedValue({ data: null, error: options.rpcError ?? null });

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "equipment_booking") return { select: bookingsSelect };
      throw new Error(`unexpected table ${table}`);
    }),
    rpc,
  };

  return { supabase: supabase as any, rpc, bookingsEq, bookingsStatusEq };
}

describe("handleEventCancelled (E3-6 / E5-6 AC4)", () => {
  it("releases the event's reservations and notifies Technical Support", async () => {
    const { supabase, rpc } = buildSupabase();
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventCancelled(buildMsg(), { supabase });

    expect(rpc).toHaveBeenCalledWith("release_equipment_for_event", { p_event_id: 7 });
    expect(publish).toHaveBeenCalledWith({
      type: "equipment.released",
      eventId: 7,
      actorId: "ORG-0001",
      recipients: { userIds: [], roles: ["technical_support"] },
      data: { eventName: "Spring Gala", reason: "event_cancelled" },
    });

    setPublisherForTest(undefined);
  });

  it("still releases (idempotent no-op) but skips the notification when there was nothing reserved", async () => {
    const { supabase, rpc } = buildSupabase({ bookings: [] });
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventCancelled(buildMsg(), { supabase });

    expect(rpc).toHaveBeenCalledWith("release_equipment_for_event", { p_event_id: 7 });
    expect(publish).not.toHaveBeenCalled();
    setPublisherForTest(undefined);
  });

  it("looks only at this event's Reserved bookings to decide whether anything was reserved", async () => {
    const { supabase, bookingsEq, bookingsStatusEq } = buildSupabase();
    setPublisherForTest({ publish: vi.fn().mockResolvedValue(true) });

    await handleEventCancelled(buildMsg(), { supabase });

    expect(bookingsEq).toHaveBeenCalledWith("event_id", 7);
    // A Released booking (migration 0052) is history, not a reservation.
    expect(bookingsStatusEq).toHaveBeenCalledWith("status", "Reserved");
    setPublisherForTest(undefined);
  });

  it("is a no-op when the message carries no eventId", async () => {
    const { supabase, rpc } = buildSupabase();
    await handleEventCancelled(buildMsg({ eventId: null }), { supabase });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("propagates a failure from the release RPC", async () => {
    const { supabase } = buildSupabase({ rpcError: { message: "boom" } });
    await expect(handleEventCancelled(buildMsg(), { supabase })).rejects.toBeTruthy();
  });
});

describe("handleEventRejected (a Planning event rejected through a clarification)", () => {
  it("releases the event's reservations and tells Technical Support it was rejected", async () => {
    const { supabase, rpc } = buildSupabase();
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventRejected(buildMsg({ type: "event.rejected" }), { supabase });

    expect(rpc).toHaveBeenCalledWith("release_equipment_for_event", { p_event_id: 7 });
    expect(publish).toHaveBeenCalledWith({
      type: "equipment.released",
      eventId: 7,
      actorId: "ORG-0001",
      recipients: { userIds: [], roles: ["technical_support"] },
      data: { eventName: "Spring Gala", reason: "event_rejected" },
    });
    setPublisherForTest(undefined);
  });

  it("skips the notification when nothing was reserved, as when it is rejected from Requested", async () => {
    const { supabase, rpc } = buildSupabase({ bookings: [] });
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventRejected(buildMsg({ type: "event.rejected" }), { supabase });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    setPublisherForTest(undefined);
  });

  it("is a no-op when the message carries no eventId", async () => {
    const { supabase, rpc } = buildSupabase();
    await handleEventRejected(buildMsg({ type: "event.rejected", eventId: null }), { supabase });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("propagates a failed release, so the message goes to the dead-letter queue", async () => {
    const { supabase } = buildSupabase({ rpcError: { message: "boom" } });
    await expect(handleEventRejected(buildMsg({ type: "event.rejected" }), { supabase })).rejects.toBeTruthy();
  });

  it("is reached through handleMessage", async () => {
    const { supabase, rpc } = buildSupabase();
    setPublisherForTest({ publish: vi.fn().mockResolvedValue(true) });
    await handleMessage(buildMsg({ type: "event.rejected" }), { supabase });
    expect(rpc).toHaveBeenCalledWith("release_equipment_for_event", { p_event_id: 7 });
    setPublisherForTest(undefined);
  });
});
