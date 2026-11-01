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
  withdrawn?: { user_id: string }[];
  updateError?: boolean;
} = {}) {
  const withdrawn = options.withdrawn ?? [{ user_id: "ATT-0001" }, { user_id: "ATT-0002" }];

  const updateSelect = vi.fn().mockResolvedValue(
    options.updateError ? { data: null, error: { message: "boom" } } : { data: withdrawn, error: null },
  );
  const updateEqStatus = vi.fn().mockReturnValue({ select: updateSelect });
  const updateEqEvent = vi.fn().mockReturnValue({ eq: updateEqStatus });
  const update = vi.fn().mockReturnValue({ eq: updateEqEvent });

  const supabase = { from: vi.fn(() => ({ update })) };
  return { supabase: supabase as any, update, updateEqEvent, updateEqStatus };
}

describe("handleEventCancelled (E3-6 AC4)", () => {
  it("marks every Registered place Cancelled (not Withdrawn) and notifies each attendee", async () => {
    const { supabase, update, updateEqEvent, updateEqStatus } = buildSupabase();
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventCancelled(buildMsg(), { supabase });

    expect(update).toHaveBeenCalledWith({ status: "Cancelled" });
    expect(updateEqEvent).toHaveBeenCalledWith("event_id", 7);
    expect(updateEqStatus).toHaveBeenCalledWith("status", "Registered");
    expect(publish).toHaveBeenCalledWith({
      type: "registration.cancelled_by_event",
      eventId: 7,
      actorId: "ORG-0001",
      recipients: { userIds: ["ATT-0001", "ATT-0002"], roles: [] },
      data: { eventName: "Spring Gala" },
    });

    setPublisherForTest(undefined);
  });

  it("is a no-op when nobody was registered", async () => {
    const { supabase } = buildSupabase({ withdrawn: [] });
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventCancelled(buildMsg(), { supabase });

    expect(publish).not.toHaveBeenCalled();
    setPublisherForTest(undefined);
  });

  it("is a no-op when the message carries no eventId", async () => {
    const { supabase, update } = buildSupabase();
    await handleEventCancelled(buildMsg({ eventId: null }), { supabase });
    expect(update).not.toHaveBeenCalled();
  });

  it("propagates a failure updating the registrations", async () => {
    const { supabase } = buildSupabase({ updateError: true });
    await expect(handleEventCancelled(buildMsg(), { supabase })).rejects.toBeTruthy();
  });

  it("updates the registrations table, only for this event's Registered places, reading back who held them", async () => {
    const { supabase, updateEqEvent, updateEqStatus, update } = buildSupabase();
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventCancelled(buildMsg(), { supabase });

    expect(supabase.from).toHaveBeenCalledWith("registrations");
    expect(update).toHaveBeenCalledWith({ status: "Cancelled" });
    expect(updateEqEvent).toHaveBeenCalledWith("event_id", 7);
    expect(updateEqStatus).toHaveBeenCalledWith("status", "Registered");
    expect(updateEqStatus.mock.results[0].value.select).toHaveBeenCalledWith("user_id");
    expect(publish).toHaveBeenCalledWith({
      type: "registration.cancelled_by_event",
      eventId: 7,
      actorId: "ORG-0001",
      recipients: { userIds: ["ATT-0001", "ATT-0002"], roles: [] },
      data: { eventName: "Spring Gala" },
    });
  });

  it("names each attendee once", async () => {
    const { supabase } = buildSupabase({ withdrawn: [{ user_id: "ATT-0001" }, { user_id: "ATT-0001" }] });
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventCancelled(buildMsg(), { supabase });

    expect(publish.mock.calls[0][0].recipients.userIds).toEqual(["ATT-0001"]);
  });

  it("reads missing rows as nobody affected", async () => {
    const { supabase, updateEqStatus } = buildSupabase();
    updateEqStatus.mockReturnValue({ select: vi.fn().mockResolvedValue({ data: null, error: null }) });
    const publish = vi.fn();
    setPublisherForTest({ publish });

    await handleEventCancelled(buildMsg(), { supabase });

    expect(publish).not.toHaveBeenCalled();
  });

  it.each([
    ["a blank name", ""],
    ["a name that isn't text", 7],
    ["no name", undefined],
  ])("leaves the event name out for %s", async (_name, eventName) => {
    const { supabase } = buildSupabase();
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });

    await handleEventCancelled(buildMsg({ data: { eventName } }), { supabase });

    expect(publish.mock.calls[0][0].data).toEqual({ eventName: undefined });
  });
});
