import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleEventRescheduled } from "../lib/eventRescheduledHandler.js";
import { handleMessage } from "../lib/handleMessage.js";
import type { InboundMessage } from "../lib/rabbitConsumer.js";
import { occupiedWindow } from "../lib/scheduleWindow.js";
import { reportArrangementsChanged } from "../lib/eventsClient.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

vi.mock("../lib/eventsClient.js", () => ({ reportArrangementsChanged: vi.fn().mockResolvedValue(true) }));
const mockedReport = vi.mocked(reportArrangementsChanged);
const publish = vi.fn().mockResolvedValue(true);

beforeEach(() => {
  mockedReport.mockClear();
  publish.mockReset().mockResolvedValue(true);
  setPublisherForTest({ publish });
});

function buildMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "22222222-2222-2222-2222-222222222222",
    type: "event.rescheduled",
    occurredAt: "2026-10-10T08:15:00Z",
    publisher: "events-service",
    actorId: "ORG-0001",
    eventId: 7,
    recipients: { userIds: [], roles: [] },
    data: { eventName: "Spring Gala", coordinatorId: "COORD-0001", proposedDate: "2099-02-02", startTime: "13:00", endTime: "15:00" },
    ...overrides,
  };
}

function buildSupabase(options: {
  error?: { message: string } | null;
  clashes?: { item_id: number; unit_id: number; kind: string }[];
  clashError?: { message: string } | null;
} = {}) {
  const statusEq = vi.fn().mockResolvedValue({ error: options.error ?? null });
  const eventEq = vi.fn().mockReturnValue({ eq: statusEq });
  const update = vi.fn().mockReturnValue({ eq: eventEq });
  const rpc = vi.fn().mockResolvedValue({ data: options.clashes ?? [], error: options.clashError ?? null });
  const supabase = { from: vi.fn((table: string) => {
    if (table === "equipment_booking") return { update };
    throw new Error(`unexpected table ${table}`);
  }), rpc };
  return { supabase: supabase as any, update, eventEq, statusEq, rpc };
}

describe("handleEventRescheduled", () => {
  it("moves the stored window of the event's Reserved bookings to the new time", async () => {
    const { supabase, update, eventEq, statusEq } = buildSupabase();
    const expected = occupiedWindow({ proposedDate: "2099-02-02", startTime: "13:00", endTime: "15:00" })!;

    await handleEventRescheduled(buildMsg(), { supabase });

    expect(update).toHaveBeenCalledWith({ window_start_ms: expected.startMs, window_end_ms: expected.endMs });
    expect(eventEq).toHaveBeenCalledWith("event_id", 7);
    // Released bookings are history and keep the window they had.
    expect(statusEq).toHaveBeenCalledWith("status", "Reserved");
  });

  it("uses the whole day when the event has no times", async () => {
    const { supabase, update } = buildSupabase();
    const expected = occupiedWindow({ proposedDate: "2099-02-02" })!;

    await handleEventRescheduled(buildMsg({ data: { proposedDate: "2099-02-02", startTime: null, endTime: null } }), { supabase });

    expect(update).toHaveBeenCalledWith({ window_start_ms: expected.startMs, window_end_ms: expected.endMs });
  });

  it("clears the window when the event has no usable date", async () => {
    const { supabase, update } = buildSupabase();

    await handleEventRescheduled(buildMsg({ data: { proposedDate: null } }), { supabase });

    expect(update).toHaveBeenCalledWith({ window_start_ms: null, window_end_ms: null });
  });

  it("is safe to process twice: the same message writes the same values", async () => {
    const { supabase, update } = buildSupabase();

    await handleEventRescheduled(buildMsg(), { supabase });
    await handleEventRescheduled(buildMsg(), { supabase });

    expect(update.mock.calls[0]).toEqual(update.mock.calls[1]);
  });

  it("ignores a message with no event id", async () => {
    const { supabase, update } = buildSupabase();

    await handleEventRescheduled(buildMsg({ eventId: null }), { supabase });

    expect(update).not.toHaveBeenCalled();
  });

  it("throws on a database error so the message goes to the dead-letter queue", async () => {
    const { supabase } = buildSupabase({ error: { message: "boom" } });

    await expect(handleEventRescheduled(buildMsg(), { supabase })).rejects.toEqual({ message: "boom" });
  });
});

describe("handleEventRescheduled: units that now clash", () => {
  const clash = [
    { item_id: 1, unit_id: 5, kind: "booking" },
    { item_id: 1, unit_id: 5, kind: "unavailable" },
    { item_id: 2, unit_id: 9, kind: "booking" },
  ];

  it("checks the event's units after moving the window", async () => {
    const { supabase, rpc } = buildSupabase();

    await handleEventRescheduled(buildMsg(), { supabase });

    expect(rpc).toHaveBeenCalledWith("equipment_reschedule_clashes", { p_event_id: 7 });
  });

  it("tells nobody when nothing clashes", async () => {
    const { supabase } = buildSupabase({ clashes: [] });

    await handleEventRescheduled(buildMsg(), { supabase });

    expect(mockedReport).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("reports the change to events-service and notifies the coordinator and Technical Support, counting each unit once", async () => {
    const { supabase } = buildSupabase({ clashes: clash });

    await handleEventRescheduled(buildMsg(), { supabase });

    expect(mockedReport).toHaveBeenCalledWith(7, "2 reserved units now clash after the event was rescheduled");
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "equipment.reservation_clash",
        eventId: 7,
        recipients: { userIds: ["COORD-0001"], roles: ["technical_support"] },
        data: { eventName: "Spring Gala", coordinatorId: "COORD-0001", units: 2 },
      }),
    );
  });

  it("notifies only Technical Support when the event has no coordinator", async () => {
    const { supabase } = buildSupabase({ clashes: [clash[0]] });

    await handleEventRescheduled(buildMsg({ data: { eventName: "Spring Gala", coordinatorId: null, proposedDate: "2099-02-02" } }), { supabase });

    expect(mockedReport).toHaveBeenCalledWith(7, "1 reserved unit now clashes after the event was rescheduled");
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ recipients: { userIds: [], roles: ["technical_support"] } }));
  });

  it("gives the notification the same id when the message is redelivered, so it is only recorded once", async () => {
    const { supabase } = buildSupabase({ clashes: clash });

    await handleEventRescheduled(buildMsg(), { supabase });
    await handleEventRescheduled(buildMsg(), { supabase });
    await handleEventRescheduled(buildMsg({ messageId: "33333333-3333-3333-3333-333333333333" }), { supabase });

    const ids = publish.mock.calls.map((c) => c[0].messageId);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("throws if the clash check fails, so the message is retried via the dead-letter queue", async () => {
    const { supabase } = buildSupabase({ clashError: { message: "boom" } });

    await expect(handleEventRescheduled(buildMsg(), { supabase })).rejects.toEqual({ message: "boom" });
  });
});

describe("handleMessage", () => {
  it("sends event.rescheduled to the reschedule handler", async () => {
    const { supabase, update } = buildSupabase();

    await handleMessage(buildMsg(), { supabase });

    expect(update).toHaveBeenCalled();
  });

  it("skips a type it has no handler for", async () => {
    const { supabase } = buildSupabase();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handleMessage(buildMsg({ type: "something.else" }), { supabase });

    expect(supabase.from).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
