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

function buildSupabase(options: {
  requests?: { id: number }[];
  itemsWithStock?: { id: number }[];
  rpcError?: { message: string } | null;
} = {}) {
  const requests = options.requests ?? [{ id: 55 }];
  const itemsWithStock = options.itemsWithStock ?? [{ id: 1 }];

  const requestsEq = vi.fn().mockResolvedValue({ data: requests, error: null });
  const requestsSelect = vi.fn().mockReturnValue({ eq: requestsEq });

  const itemsGt = vi.fn().mockResolvedValue({ data: itemsWithStock, error: null });
  const itemsIn = vi.fn().mockReturnValue({ gt: itemsGt });
  const itemsSelect = vi.fn().mockReturnValue({ in: itemsIn });

  const rpc = vi.fn().mockResolvedValue({ data: null, error: options.rpcError ?? null });

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === "equipment_requests") return { select: requestsSelect };
      if (table === "equipment_request_items") return { select: itemsSelect };
      throw new Error(`unexpected table ${table}`);
    }),
    rpc,
  };

  return { supabase: supabase as any, rpc, requestsEq, itemsIn, itemsGt };
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
    const { supabase, rpc } = buildSupabase({ itemsWithStock: [] });
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventCancelled(buildMsg(), { supabase });

    expect(rpc).toHaveBeenCalledWith("release_equipment_for_event", { p_event_id: 7 });
    expect(publish).not.toHaveBeenCalled();
    setPublisherForTest(undefined);
  });

  it("skips the quantity check (and the notification) when the event has no equipment requests at all", async () => {
    const { supabase, rpc, itemsIn } = buildSupabase({ requests: [] });
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventCancelled(buildMsg(), { supabase });

    expect(itemsIn).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("release_equipment_for_event", { p_event_id: 7 });
    expect(publish).not.toHaveBeenCalled();
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
