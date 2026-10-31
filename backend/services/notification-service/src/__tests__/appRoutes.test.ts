import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: {} }));

import { app } from "../app.js";

describe("app wiring", () => {
  it("GET /health returns {ok:true}", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("mounts the notifications router at /api/notifications behind auth", async () => {
    const res = await request(app).get("/api/notifications");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("no_token");
  });

  it("sends CORS headers", async () => {
    const res = await request(app).get("/health").set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("parses JSON bodies (a malformed one is rejected, not crashed on)", async () => {
    const res = await request(app).post("/api/notifications/read").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
  });
});
