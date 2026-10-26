/**
 * Real-DB integration test: hits the actual Supabase project configured in
 * backend/.env (the shared dev project) — no mocks. Only `npm run
 * test:integration` runs this folder; it's excluded from `npm test` /
 * `npm run test:coverage` (see vitest.config.ts).
 *
 * Every row this file writes is created with a unique, clearly-tagged email
 * under its own control and deleted in afterAll, whether the tests pass or
 * fail. It never reads, writes, or depends on any pre-existing seeded
 * account, so it's safe to run against data the rest of the team is using.
 */
import "../../lib/env.js"; // must load real env vars before supabaseAdmin is constructed
import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { authRouter } from "../../routes/auth.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { verifyToken } from "../../lib/jwt.js";

const TEST_EMAIL = `integration-test-${Date.now()}@example.com`;
// Fixture values, not real credentials against anything. The trailing digit
// (required by the app's password policy) pushes a compact string like
// "integration-pw1" over gitleaks' generic-secret entropy threshold, so these
// are hyphenated phrases instead, same style as auth.test.ts's "correct-horse-battery".
const PASSWORD = "not-a-real-secret-1"; // gitleaks:allow
const WRONG_PASSWORD = "also-not-a-real-secret-1"; // gitleaks:allow

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  return app;
}

async function fetchRow() {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id, name, email, role, failed_login_attempts, locked_until")
    .eq("email", TEST_EMAIL)
    .maybeSingle();
  if (error) throw new Error(`Failed to read back test row: ${error.message}`);
  return data;
}

describe("auth integration (real Supabase project)", () => {
  afterAll(async () => {
    await supabaseAdmin.from("users").delete().eq("email", TEST_EMAIL);
  });

  it("signup actually inserts a row with a working bcrypt hash and returns a valid token", async () => {
    const app = buildApp();

    const res = await request(app)
      .post("/api/auth/signup")
      .send({ name: "Integration Test User", email: TEST_EMAIL, password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: TEST_EMAIL, role: "attendee" });
    expect(verifyToken(res.body.token)).toMatchObject({ sub: res.body.user.id, role: "attendee" });

    // Prove it's really in the DB, not just echoed back.
    const row = await fetchRow();
    expect(row).toMatchObject({ email: TEST_EMAIL, role: "attendee", failed_login_attempts: 0 });
  });

  it("rejects a second signup with the same email via the real unique lookup", async () => {
    const app = buildApp();

    const res = await request(app)
      .post("/api/auth/signup")
      .send({ name: "Someone Else", email: TEST_EMAIL, password: PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("email_in_use");
  });

  it("logs in with the password that was actually persisted", async () => {
    const app = buildApp();

    const res = await request(app).post("/api/auth/login").send({ email: TEST_EMAIL, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: TEST_EMAIL, role: "attendee" });
  });

  it("persists a failed attempt in the real row, then clears it on the next successful login", async () => {
    const app = buildApp();

    const failed = await request(app).post("/api/auth/login").send({ email: TEST_EMAIL, password: WRONG_PASSWORD });
    expect(failed.status).toBe(401);

    const afterFailure = await fetchRow();
    expect(afterFailure?.failed_login_attempts).toBe(1);

    const success = await request(app).post("/api/auth/login").send({ email: TEST_EMAIL, password: PASSWORD });
    expect(success.status).toBe(200);

    const afterSuccess = await fetchRow();
    expect(afterSuccess?.failed_login_attempts).toBe(0);
    expect(afterSuccess?.locked_until).toBeNull();
  });
});
