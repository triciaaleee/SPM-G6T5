// @ts-nocheck
// 
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";
import { signWithClock } from "./tokens.js";

/** An arrangement the event was approved on is gone: venue-service / equipment-service tell us. */

vi.mock("../middleware/auth.js", () => {
  const applyMock = (req: AuthedRequest, _res: unknown, next: () => void) => next();
  return { requireAuth: applyMock, requireAuthOrInternal: applyMock };
});

vi.mock("../lib/supabaseAdmin.js", () => ({
  supabaseAdmin: { from: (table: string) => (globalThis as any).__tables[table] },
}));

process.env.INTERNAL_SERVICE_SECRET = "test-internal-secret";
const internalHeader = () => signWithClock({ svc: "venue-service" }, "test-internal-secret", { expiresIn: "60s" });

const publish = vi.fn().mockResolvedValue(true);
const update = vi.fn();

function buildApp(event: Record<string, unknown> | null, matched = true) {
  update.mockReset();
  (globalThis as any).__tables = {
    events: {
      select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: event, error: null }) }) }),
      update: (patch: Record<string, unknown>) => {
        update(patch);
        const chain: any = {
          eq: () => chain,
          select: vi.fn().mockResolvedValue({ data: matched ? [{ id: 7 }] : [], error: null }),
        };
        return chain;
      },
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/events", eventsRouter);
  return app;
}

const baseEvent = {
  id: 7,
  coordinator_id: "COORD-0001",
  organiser_id: "ORG-0001",
  submitted_details: { name: "Spring Gala" },
};

beforeEach(() => {
  publish.mockReset().mockResolvedValue(true);
  setPublisherForTest({ publish });
});

const call = (app: express.Express, body: unknown = { reason: "Hall A is unavailable" }, token: string | null = internalHeader()) => {
  const req = request(app).post("/api/events/7/arrangements-changed");
  return (token ? req.set("X-Internal-Auth", token) : req).send(body as object);
};

describe("POST /api/events/:id/arrangements-changed", () => {
  it("rejects a caller with no internal token", async () => {
    const res = await call(buildApp({ ...baseEvent, status: "Confirmed" }), undefined, null);
    expect(res.status).toBe(401);
  });

  it("rejects a forged internal token", async () => {
    const forged = signWithClock({ svc: "x" }, "wrong-secret");
    const res = await call(buildApp({ ...baseEvent, status: "Confirmed" }), undefined, forged);
    expect(res.status).toBe(401);
  });

  it("requires a reason", async () => {
    const res = await call(buildApp({ ...baseEvent, status: "Confirmed" }), {});
    expect(res.status).toBe(400);
  });

  it("404s an unknown event", async () => {
    const res = await call(buildApp(null));
    expect(res.status).toBe(404);
  });

  it("moves a Confirmed event to Needs Review, marks approval stale and notifies coordinator and organiser", async () => {
    const res = await call(buildApp({ ...baseEvent, status: "Confirmed" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, status: "Needs Review" });
    expect(update).toHaveBeenCalledWith({ status: "Needs Review", safety_approval_stale: true });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "event.needs_review",
        recipients: { userIds: ["COORD-0001", "ORG-0001"], roles: [] },
      }),
    );
  });

  it("returns a Safety Review event to Planning and tells the Safety Officer", async () => {
    const res = await call(buildApp({ ...baseEvent, status: "Safety Review" }));
    expect(res.body).toMatchObject({ changed: true, status: "Planning" });
    expect(update).toHaveBeenCalledWith({ status: "Planning", safety_approval_stale: true });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "event.returned_to_planning", recipients: expect.objectContaining({ roles: ["safety_officer"] }) }),
    );
  });

  it("keeps a Needs Review event there, only marking approval stale, without a new notice", async () => {
    const res = await call(buildApp({ ...baseEvent, status: "Needs Review" }));
    expect(res.body).toMatchObject({ changed: false, status: "Needs Review" });
    expect(update).toHaveBeenCalledWith({ status: "Needs Review", safety_approval_stale: true });
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(["Draft", "Unassigned", "Requested", "Planning", "Completed", "Cancelled", "Rejected"])(
    "does nothing for a %s event",
    async (status) => {
      const res = await call(buildApp({ ...baseEvent, status }));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ changed: false, status });
      expect(update).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    },
  );

  it("409s if the event moved on between the read and the write", async () => {
    const res = await call(buildApp({ ...baseEvent, status: "Confirmed" }, false));
    expect(res.status).toBe(409);
    expect(publish).not.toHaveBeenCalled();
  });
});
