// @ts-nocheck
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const from = vi.fn();
vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: { from: (...args: unknown[]) => from(...args) } }));

const { publicEventsRouter } = await import("../routes/publicEvents.js");

const details = {
  name: "Campus Fair",
  description: "Stalls and food",
  proposedDate: "2099-01-01",
  startTime: "10:00",
  endTime: "16:00",
  expectedAttendance: 50,
  accessibility: "Step-free access",
  registrationNeeded: true,
  purpose: "INTERNAL purpose",
  equipment: "INTERNAL equipment",
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: "Confirmed",
    registration_open_date: "2020-01-01",
    registration_override: "NONE",
    submitted_details: details,
    organiser: { name: "Pat Organiser", email: "pat@example.com" },
    ...overrides,
  };
}

/** `.select().eq()` resolves the list; `.eq().eq().maybeSingle()` resolves one row. */
function mockEvents(rows: Record<string, unknown>[], error: unknown = null) {
  const query: Record<string, any> = {};
  query.select = vi.fn(() => query);
  query.eq = vi.fn(() => query);
  query.maybeSingle = vi.fn().mockResolvedValue({ data: rows[0] ?? null, error });
  query.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows, error }).then(resolve);
  from.mockReturnValue(query);
  return query;
}

function buildApp() {
  const app = express();
  app.use("/api/events/public", publicEventsRouter);
  return app;
}

beforeEach(() => from.mockReset());

describe("GET /api/events/public", () => {
  it("needs no token and lists only Confirmed events whose registration has opened", async () => {
    const query = mockEvents([
      row(),
      row({ id: 2, registration_open_date: "2098-12-01" }),
      row({ id: 3, submitted_details: { ...details, registrationNeeded: false } }),
    ]);

    const res = await request(buildApp()).get("/api/events/public");

    expect(res.status).toBe(200);
    expect(query.eq).toHaveBeenCalledWith("status", "Confirmed");
    expect(res.body.events.map((e: { id: number }) => e.id)).toEqual([1]);
  });

  it("returns only the attendee-facing fields — no internal details, organiser email or capacity", async () => {
    mockEvents([row()]);

    const res = await request(buildApp()).get("/api/events/public");

    expect(res.body.events[0]).toEqual({
      id: 1,
      name: "Campus Fair",
      description: "Stalls and food",
      proposedDate: "2099-01-01",
      startTime: "10:00",
      endTime: "16:00",
      accessibility: "Step-free access",
      organiserName: "Pat Organiser",
      registrationState: "OPEN",
      open: true,
    });
    expect(JSON.stringify(res.body)).not.toContain("INTERNAL");
    expect(JSON.stringify(res.body)).not.toContain("pat@example.com");
  });

  it("keeps a closed event listed, marked CLOSED", async () => {
    mockEvents([row({ registration_override: "FORCE_CLOSED" })]);

    const res = await request(buildApp()).get("/api/events/public");

    expect(res.body.events[0]).toMatchObject({ registrationState: "CLOSED", open: false });
  });

  it("answers 500 when the query fails", async () => {
    mockEvents([], { message: "boom" });

    const res = await request(buildApp()).get("/api/events/public");

    expect(res.status).toBe(500);
  });
});

describe("GET /api/events/public/:id", () => {
  it("returns one listed event", async () => {
    const query = mockEvents([row({ id: 7 })]);

    const res = await request(buildApp()).get("/api/events/public/7");

    expect(res.status).toBe(200);
    expect(query.eq).toHaveBeenCalledWith("id", 7);
    expect(res.body.event).toMatchObject({ id: 7, name: "Campus Fair", open: true });
  });

  it("answers 404 for an event whose registration hasn't opened", async () => {
    mockEvents([row({ registration_open_date: "2098-12-01" })]);

    const res = await request(buildApp()).get("/api/events/public/1");

    expect(res.status).toBe(404);
  });

  it("answers 404 when there is no such Confirmed event", async () => {
    mockEvents([]);

    const res = await request(buildApp()).get("/api/events/public/99");

    expect(res.status).toBe(404);
  });

  it("answers 400 for a malformed id", async () => {
    const res = await request(buildApp()).get("/api/events/public/abc");

    expect(res.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
});
