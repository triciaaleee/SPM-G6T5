import { beforeEach, describe, expect, it, vi } from "vitest";

const { cancelled, rejected, rescheduled } = vi.hoisted(() => ({
  cancelled: vi.fn(async (..._args: unknown[]) => {}),
  rejected: vi.fn(async (..._args: unknown[]) => {}),
  rescheduled: vi.fn(async (..._args: unknown[]) => {}),
}));
vi.mock("../lib/eventCancelledHandler.js", () => ({ handleEventCancelled: cancelled }));
vi.mock("../lib/eventRejectedHandler.js", () => ({ handleEventRejected: rejected }));
vi.mock("../lib/eventRescheduledHandler.js", () => ({ handleEventRescheduled: rescheduled }));

import { handleMessage } from "../lib/handleMessage.js";
import type { InboundMessage } from "../lib/rabbitConsumer.js";

const deps = { supabase: { marker: "db" } as any };
const msg = (type: string): InboundMessage => ({
  messageId: "m1",
  type,
  occurredAt: "2026-10-28T04:00:00.000Z",
  publisher: "events-service",
  actorId: null,
  eventId: 1,
  recipients: { userIds: [], roles: [] },
  data: {},
});

beforeEach(() => vi.clearAllMocks());

describe("handleMessage", () => {
  it.each([
    ["event.cancelled", () => cancelled],
    ["event.rejected", () => rejected],
    ["event.rescheduled", () => rescheduled],
  ])("routes %s to its own handler only", async (type, handler) => {
    const m = msg(type);
    await handleMessage(m, deps);
    expect(handler()).toHaveBeenCalledExactlyOnceWith(m, deps);
    const others = [cancelled, rejected, rescheduled].filter((h) => h !== handler());
    for (const other of others) expect(other).not.toHaveBeenCalled();
  });

  it("warns and skips a type it has no handler for", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await handleMessage(msg("event.updated"), deps);
    expect(warn).toHaveBeenCalledWith('equipment-service: no handler for "event.updated", skipping');
    expect([cancelled, rejected, rescheduled].every((h) => h.mock.calls.length === 0)).toBe(true);
    warn.mockRestore();
  });

  it("propagates a handler failure so the consumer can dead-letter it", async () => {
    cancelled.mockRejectedValueOnce(new Error("db down"));
    await expect(handleMessage(msg("event.cancelled"), deps)).rejects.toThrow("db down");
  });
});
