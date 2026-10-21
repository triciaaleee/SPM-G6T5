import { afterEach, describe, expect, it, vi } from "vitest";
import { flushOutbox } from "../lib/outbox.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

function row(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    message_id: `00000000-0000-0000-0000-00000000000${id}`,
    type: "event.cancelled",
    event_id: 7,
    actor_id: "ORG-0001",
    recipients: { userIds: ["ORG-0001"], roles: [] },
    data: { eventName: "Spring Gala", reason: "Venue flooded" },
    occurred_at: "2026-01-01T00:00:00Z",
    attempts: 0,
    ...overrides,
  };
}

function buildSupabase(rows: Record<string, unknown>[], options: { readError?: boolean } = {}) {
  const limit = vi.fn().mockResolvedValue(options.readError ? { data: null, error: { message: "boom" } } : { data: rows, error: null });
  const order = vi.fn().mockReturnValue({ limit });
  const is = vi.fn().mockReturnValue({ order });
  const select = vi.fn().mockReturnValue({ is });
  const eq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn().mockReturnValue({ eq });
  const supabase = { from: vi.fn(() => ({ select, update })) };
  return { supabase: supabase as never, is, update, eq };
}

afterEach(() => setPublisherForTest(undefined));

describe("flushOutbox", () => {
  it("publishes what is waiting, oldest first, with the stored message id, and marks each published", async () => {
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });
    const { supabase, is, update, eq } = buildSupabase([row(1), row(2)]);

    const count = await flushOutbox(supabase);

    expect(count).toBe(2);
    expect(is).toHaveBeenCalledWith("published_at", null);
    expect(publish.mock.calls.map((c) => c[0].messageId)).toEqual([
      "00000000-0000-0000-0000-000000000001",
      "00000000-0000-0000-0000-000000000002",
    ]);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "event.cancelled", eventId: 7, occurredAt: "2026-01-01T00:00:00Z" }),
    );
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ published_at: expect.any(String) }));
    expect(eq.mock.calls.map((c) => c[1])).toEqual([1, 2]);
  });

  it("stops at the first failure so a later message can't overtake it, and records the attempt", async () => {
    const publish = vi.fn().mockResolvedValue(false);
    setPublisherForTest({ publish });
    const { supabase, update, eq } = buildSupabase([row(1, { attempts: 2 }), row(2)]);

    const count = await flushOutbox(supabase);

    expect(count).toBe(0);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ attempts: 3, last_error: expect.any(String) });
    expect(eq).toHaveBeenCalledWith("id", 1);
  });

  it("does nothing when there is nothing waiting", async () => {
    const publish = vi.fn();
    setPublisherForTest({ publish });
    const { supabase } = buildSupabase([]);

    expect(await flushOutbox(supabase)).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("returns 0 without throwing when the outbox can't be read", async () => {
    const publish = vi.fn();
    setPublisherForTest({ publish });
    const { supabase } = buildSupabase([], { readError: true });

    expect(await flushOutbox(supabase)).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });
});
