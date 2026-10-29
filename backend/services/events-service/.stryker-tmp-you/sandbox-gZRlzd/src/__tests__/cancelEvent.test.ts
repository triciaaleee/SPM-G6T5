// @ts-nocheck
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

vi.mock("../middleware/auth.js", async () => {
  const applyMock = (req: AuthedRequest, _res: unknown, next: () => void) => {
    req.user = (globalThis as any).__mockUser;
    req.supabase = (globalThis as any).__mockSupabase;
    next();
  };
  return { requireAuth: applyMock, requireAuthOrInternal: applyMock };
});

const organiser = { id: "ORG-0001", role: "organiser" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function buildApp(
  options: {
    user?: { id: string; role: string };
    event?: { id: number; status: string; organiser_id: string | null; coordinator_id: string | null } | null;
    fetchError?: boolean;
    updateError?: boolean;
    updateConflict?: boolean;
    historyError?: boolean;
    notificationsFail?: boolean;
    outboxError?: boolean;
  } = {},
) {
  const event =
    options.event === undefined
      ? { id: 7, status: "Planning", organiser_id: "ORG-0001", coordinator_id: "COORD-0001" }
      : options.event;

  const reloaded = {
    id: event?.id,
    status: "Cancelled",
    submitted_details: { name: "Spring Gala" },
    coordinator_id: event?.coordinator_id ?? null,
    organiser_id: event?.organiser_id ?? null,
    review_outcome: null,
    decided_at: null,
    decided_by: null,
    created_at: "2026-01-01T00:00:00Z",
  };

  const eventsSelect = vi.fn().mockReturnValue({
    eq: () => ({
      maybeSingle: vi
        .fn()
        .mockResolvedValue(options.fetchError ? { data: null, error: { message: "boom" } } : { data: event, error: null }),
    }),
  });

  const updateMaybeSingle = vi.fn().mockResolvedValue(
    options.updateError
      ? { data: null, error: { message: "boom" } }
      : options.updateConflict
        ? { data: null, error: null }
        : { data: reloaded, error: null },
  );
  const updateSelect = vi.fn().mockReturnValue({ maybeSingle: updateMaybeSingle });
  const updateEqStatus = vi.fn().mockReturnValue({ select: updateSelect });
  const updateEqId = vi.fn().mockReturnValue({ eq: updateEqStatus });
  const update = vi.fn().mockReturnValue({ eq: updateEqId });

  const historyInsert = vi
    .fn()
    .mockResolvedValue(options.historyError ? { error: { message: "boom" } } : { error: null });
  const denialInsert = vi.fn().mockResolvedValue({ error: null });

  // The outbox echoes back what was inserted, plus the id and message_id the database would add.
  const outboxInsert = vi.fn((row: Record<string, unknown>) => ({
    select: () => ({
      single: vi.fn().mockResolvedValue(
        options.outboxError
          ? { data: null, error: { message: "boom" } }
          : {
              data: { id: 1, message_id: "11111111-1111-1111-1111-111111111111", occurred_at: "2026-01-01T00:00:00Z", ...row },
              error: null,
            },
      ),
    }),
  }));
  const outboxMarkPublished = vi.fn().mockResolvedValue({ error: null });
  const outboxUpdate = vi.fn(() => ({ eq: outboxMarkPublished }));

  (globalThis as any).__mockSupabase = {
    from: vi.fn((table: string) => {
      if (table === "events") return { select: eventsSelect, update };
      if (table === "event_history") return { insert: historyInsert };
      if (table === "access_denials") return { insert: denialInsert };
      if (table === "event_outbox") return { insert: outboxInsert, update: outboxUpdate };
      throw new Error(`unexpected table ${table}`);
    }),
  };
  (globalThis as any).__mockUser = options.user ?? organiser;

  const publish = vi.fn().mockResolvedValue(!options.notificationsFail);
  setPublisherForTest({ publish });

  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  return { app, update, updateEqId, updateEqStatus, historyInsert, denialInsert, publish, outboxInsert, outboxUpdate, outboxMarkPublished };
}

function cancel(app: express.Express, id: number | string = 7, body: unknown = { reason: "Venue flooded" }) {
  return request(app).post(`/api/events/${id}/cancel`).set("Authorization", "Bearer t").send(body as object);
}

describe("POST /api/events/:id/cancel (E3-6)", () => {
  it("AC1: cancels a Planning event, records history and publishes event.cancelled to the organiser and assigned coordinator", async () => {
    const { app, update, updateEqId, updateEqStatus, historyInsert, publish } = buildApp();
    const res = await cancel(app);

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Cancelled");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Cancelled", review_outcome: "Venue flooded", decided_by: "ORG-0001" }),
    );
    expect(updateEqId).toHaveBeenCalledWith("id", 7);
    expect(updateEqStatus).toHaveBeenCalledWith("status", "Planning");
    expect(historyInsert).toHaveBeenCalledWith([
      expect.objectContaining({ field: "Status", old_value: "Planning", new_value: "Cancelled" }),
      expect.objectContaining({ field: "Cancellation reason", old_value: null, new_value: "Venue flooded" }),
    ]);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "event.cancelled",
        eventId: 7,
        actorId: "ORG-0001",
        recipients: { userIds: ["ORG-0001", "COORD-0001"], roles: [] },
        data: { eventName: "Spring Gala", reason: "Venue flooded" },
      }),
    );
  });

  it("AC1: notifies every Event Coordinator Lead when the event has no coordinator yet (Unassigned)", async () => {
    const { app, publish } = buildApp({
      event: { id: 7, status: "Unassigned", organiser_id: "ORG-0001", coordinator_id: null },
    });
    const res = await cancel(app);

    expect(res.status).toBe(200);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        recipients: { userIds: ["ORG-0001"], roles: ["coordinator_lead"] },
      }),
    );
  });

  it.each(["Unassigned", "Requested", "Clarification Requested", "Planning", "Safety Review", "Confirmed"])(
    "allows cancelling from %s",
    async (status) => {
      const { app } = buildApp({ event: { id: 7, status, organiser_id: "ORG-0001", coordinator_id: "COORD-0001" } });
      const res = await cancel(app);
      expect(res.status).toBe(200);
    },
  );

  it.each(["Draft", "Rejected", "Cancelled", "Completed"])("blocks cancelling a %s event", async (status) => {
    const { app, update } = buildApp({ event: { id: 7, status, organiser_id: "ORG-0001", coordinator_id: "COORD-0001" } });
    const res = await cancel(app);
    expect(res.status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it("AC2: requires a non-empty reason", async () => {
    const { app, update } = buildApp();
    const res = await cancel(app, 7, {});
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("AC2: rejects a whitespace-only reason", async () => {
    const { app, update } = buildApp();
    const res = await cancel(app, 7, { reason: "   " });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("blocks a non-owner", async () => {
    const { app, update } = buildApp({ user: { id: "ORG-0002", role: "organiser" } });
    const res = await cancel(app);
    expect(res.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown event", async () => {
    const { app } = buildApp({ event: null });
    expect((await cancel(app)).status).toBe(404);
  });

  it("returns 404 for a malformed event id", async () => {
    const { app } = buildApp();
    expect((await cancel(app, "abc")).status).toBe(404);
  });

  it("returns 500 when the event can't be loaded", async () => {
    const { app } = buildApp({ fetchError: true });
    expect((await cancel(app)).status).toBe(500);
  });

  it("returns 500 when the cancellation can't be written", async () => {
    const { app } = buildApp({ updateError: true });
    expect((await cancel(app)).status).toBe(500);
  });

  it("returns 409 when the event changed between the check and the write", async () => {
    const { app } = buildApp({ updateConflict: true });
    expect((await cancel(app)).status).toBe(409);
  });

  it("stores event.cancelled in the outbox, publishes it with the stored message id, then marks it published", async () => {
    const { app, outboxInsert, publish, outboxUpdate, outboxMarkPublished } = buildApp();
    const res = await cancel(app);

    expect(res.status).toBe(200);
    expect(outboxInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "event.cancelled",
        event_id: 7,
        actor_id: "ORG-0001",
        recipients: { userIds: ["ORG-0001", "COORD-0001"], roles: [] },
        data: { eventName: "Spring Gala", reason: "Venue flooded" },
      }),
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "event.cancelled", messageId: "11111111-1111-1111-1111-111111111111" }),
    );
    expect(outboxUpdate).toHaveBeenCalledWith(expect.objectContaining({ published_at: expect.any(String) }));
    expect(outboxMarkPublished).toHaveBeenCalledWith("id", 1);
    expect(res.body.notificationsFailed).toBe(false);
  });

  it("keeps the message in the outbox for the relay when the broker is down, and doesn't report a failure", async () => {
    const { app, outboxUpdate } = buildApp({ notificationsFail: true });
    const res = await cancel(app);

    expect(res.status).toBe(200);
    expect(res.body.event.status).toBe("Cancelled");
    expect(outboxUpdate).not.toHaveBeenCalled();
    expect(res.body.notificationsFailed).toBe(false);
  });

  it("falls back to publishing directly when the outbox can't be written", async () => {
    const { app, publish } = buildApp({ outboxError: true });
    const res = await cancel(app);

    expect(res.status).toBe(200);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: "event.cancelled" }));
    expect(res.body.notificationsFailed).toBe(false);
  });

  it("reports notificationsFailed only when the outbox is unwritable and the direct publish fails too", async () => {
    const { app } = buildApp({ outboxError: true, notificationsFail: true });
    const res = await cancel(app);

    expect(res.status).toBe(200);
    expect(res.body.notificationsFailed).toBe(true);
  });
});
