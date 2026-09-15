import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

function buildApp() {
  const app = express();
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("GET /health", () => {
  it("returns ok", async () => {
    const app = buildApp();
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
