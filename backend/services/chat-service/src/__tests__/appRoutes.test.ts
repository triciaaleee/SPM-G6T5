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

  it("mounts the chat router at /api/chat behind auth", async () => {
    const res = await request(app).get("/api/chat/threads");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("no_token");
  });

  it("does not expose chat routes at the root", async () => {
    expect((await request(app).get("/threads")).status).toBe(404);
  });

  it("sends CORS headers", async () => {
    const res = await request(app).get("/health").set("Origin", "http://localhost:5173");
    expect(res.headers["access-control-allow-origin"]).toBeDefined();
  });

  it("answers CORS preflight", async () => {
    const res = await request(app).options("/api/chat/threads").set("Origin", "http://x").set("Access-Control-Request-Method", "GET");
    expect(res.status).toBe(204);
  });

  it("parses JSON bodies (a malformed one is rejected, not crashed on)", async () => {
    const res = await request(app).post("/api/chat/1/messages").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
  });
});

describe("CORS_ORIGIN", () => {
  it("only echoes allowed origins when CORS_ORIGIN is set", async () => {
    process.env.CORS_ORIGIN = "https://app.example.com, https://admin.example.com";
    vi.resetModules();
    const { app: pinned } = await import("../app.js");
    const ok = await request(pinned).get("/health").set("Origin", "https://admin.example.com");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://admin.example.com");
    const bad = await request(pinned).get("/health").set("Origin", "https://evil.example.com");
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    delete process.env.CORS_ORIGIN;
  });

  it("is open when unset or blank", async () => {
    process.env.CORS_ORIGIN = " , ";
    vi.resetModules();
    const { app: open } = await import("../app.js");
    const res = await request(open).get("/health").set("Origin", "https://anywhere.example.com");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    delete process.env.CORS_ORIGIN;
  });
});
