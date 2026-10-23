/**
 * Real-DB integration test for the role-listing and name-lookup endpoints.
 * Inserts its own throwaway "coordinator" row directly (self-signup can't
 * create staff roles) under an id prefix ("ZINT-") that can never collide
 * with a real generate_user_id()-issued id, so it never touches or risks
 * the id sequence of any real role. Deleted in afterAll regardless of
 * outcome. See authFlow.test.ts for the run/exclusion story.
 */
import "../../lib/env.js";
import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usersRouter } from "../../routes/users.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { signToken } from "../../lib/jwt.js";

const TEST_ID = `ZINT-${Date.now()}`;
const TEST_NAME = "Integration Test Coordinator";
const TEST_EMAIL = `integration-test-coordinator-${Date.now()}@example.com`;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/users", usersRouter);
  return app;
}

describe("users query integration (real Supabase project)", () => {
  beforeAll(async () => {
    const { error } = await supabaseAdmin.from("users").insert({
      id: TEST_ID,
      name: TEST_NAME,
      email: TEST_EMAIL,
      password_hash: bcrypt.hashSync("unused-placeholder1", 4),
      role: "coordinator",
    });
    if (error) throw new Error(`Failed to seed the integration test coordinator row: ${error.message}`);
  });

  afterAll(async () => {
    await supabaseAdmin.from("users").delete().eq("id", TEST_ID);
  });

  it("GET /api/users?role=coordinator returns the real row, id and name only", async () => {
    const app = buildApp();
    const leadToken = signToken({ sub: "integration-lead", role: "coordinator_lead" });

    const res = await request(app)
      .get("/api/users?role=coordinator")
      .set("Authorization", `Bearer ${leadToken}`);

    expect(res.status).toBe(200);
    expect(res.body.users).toContainEqual({ id: TEST_ID, name: TEST_NAME });
    // Whitelist check: nothing beyond id/name ever crosses the wire.
    for (const user of res.body.users) {
      expect(Object.keys(user).sort()).toEqual(["id", "name"]);
    }
  });

  it("GET /api/users/names resolves the same real row for an organiser", async () => {
    const app = buildApp();
    const orgToken = signToken({ sub: "integration-org", role: "organiser" });

    const res = await request(app)
      .get(`/api/users/names?ids=${TEST_ID}`)
      .set("Authorization", `Bearer ${orgToken}`);

    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([{ id: TEST_ID, name: TEST_NAME }]);
  });
});
