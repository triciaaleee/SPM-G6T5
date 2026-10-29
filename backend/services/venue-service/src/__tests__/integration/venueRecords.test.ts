/**
 * Real-DB integration: venue staff add / list / edit a venue (E4-1) and a
 * coordinator finds it through search and filters. Exercises the real
 * Postgres constraints and the staff_id → users foreign key. Run with
 * `npm run test:integration`; never part of `npm test`.
 */
import "../../lib/env.js";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signToken } from "../../lib/jwt.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { staffRouter } from "../../routes/staff.js";
import { venuesRouter } from "../../routes/venues.js";
import { COORD_ID, RUN, STAFF_ID, seedUsers, teardown, venueBody } from "./helpers.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/venues/staff", staffRouter);
  app.use("/api/venues", venuesRouter);
  return app;
}

const app = buildApp();
const staffAuth = () => `Bearer ${signToken({ sub: STAFF_ID, role: "venue_staff" })}`;
const coordAuth = () => `Bearer ${signToken({ sub: COORD_ID, role: "coordinator" })}`;

describe("venue records integration (real Supabase project)", () => {
  let venueId: number;

  beforeAll(async () => {
    process.env.JWT_SECRET ||= "integration-secret";
    await seedUsers();
  });
  afterAll(teardown);

  it("rejects an incomplete venue and writes nothing", async () => {
    const res = await request(app)
      .post("/api/venues/staff/venues")
      .set("Authorization", staffAuth())
      .send(venueBody({ name: "", capacity: 0 }));

    expect(res.status).toBe(400);
    expect(res.body.fields).toHaveProperty("name");
    expect(res.body.fields).toHaveProperty("capacity");
    const { data } = await supabaseAdmin.from("venues").select("id").eq("staff_id", STAFF_ID);
    expect(data).toEqual([]);
  });

  it("creates a venue owned by the caller, Available from the start", async () => {
    const res = await request(app).post("/api/venues/staff/venues").set("Authorization", staffAuth()).send(venueBody());

    expect(res.status).toBe(201);
    expect(res.body.venue).toMatchObject({ name: `ZINT Venue ${RUN}`, capacity: 80 });
    venueId = res.body.venue.id;

    const { data } = await supabaseAdmin.from("venues").select("status, active, staff_id").eq("id", venueId).single();
    expect(data).toEqual({ status: "Available", active: true, staff_id: STAFF_ID });
  });

  it("lists it under my-venues for its owner and the picker", async () => {
    const mine = await request(app).get("/api/venues/staff/my-venues").set("Authorization", staffAuth());
    expect(mine.status).toBe(200);
    expect(mine.body.venues.map((v: { id: number }) => v.id)).toEqual([venueId]);

    const picker = await request(app).get("/api/venues/staff/venues").set("Authorization", staffAuth());
    expect(picker.body.venues).toContainEqual({ id: venueId, name: `ZINT Venue ${RUN}` });
  });

  it("previews then saves an edit; the row changes in the database", async () => {
    const edit = venueBody({ capacity: 120, setupMinutes: 5 });

    const preview = await request(app)
      .post(`/api/venues/staff/venues/${venueId}/preview`)
      .set("Authorization", staffAuth())
      .send(edit);
    expect(preview.status).toBe(200);
    const before = await supabaseAdmin.from("venues").select("capacity").eq("id", venueId).single();
    expect(before.data?.capacity).toBe(80); // preview wrote nothing

    const saved = await request(app)
      .patch(`/api/venues/staff/venues/${venueId}`)
      .set("Authorization", staffAuth())
      .send(edit);
    expect(saved.status).toBe(200);
    expect(saved.body.venue).toMatchObject({ capacity: 120, setupMinutes: 5 });

    const after = await supabaseAdmin.from("venues").select("capacity, setup_minutes").eq("id", venueId).single();
    expect(after.data).toEqual({ capacity: 120, setup_minutes: 5 });
  });

  it("refuses to edit a venue the caller does not look after, and an unknown one", async () => {
    const other = `Bearer ${signToken({ sub: `ZINT-OTHER-${RUN}`, role: "venue_staff" })}`;

    const forbidden = await request(app)
      .patch(`/api/venues/staff/venues/${venueId}`)
      .set("Authorization", other)
      .send(venueBody());
    expect(forbidden.status).toBe(403);

    const missing = await request(app)
      .patch("/api/venues/staff/venues/2147483647")
      .set("Authorization", staffAuth())
      .send(venueBody());
    expect(missing.status).toBe(404);

    const badId = await request(app)
      .patch("/api/venues/staff/venues/abc")
      .set("Authorization", staffAuth())
      .send(venueBody());
    expect(badId.status).toBe(400);
  });

  it("keeps staff-only routes away from coordinators, and search away from staff", async () => {
    expect((await request(app).get("/api/venues/staff/my-venues").set("Authorization", coordAuth())).status).toBe(403);
    expect((await request(app).get("/api/venues").set("Authorization", staffAuth())).status).toBe(403);
    expect((await request(app).get("/api/venues")).status).toBe(401);
  });

  it("a coordinator's search finds the venue by capacity and facility, and filters list its values", async () => {
    const hit = await request(app)
      .get("/api/venues")
      .query({ capacityMin: 100, facilities: "Projector" })
      .set("Authorization", coordAuth());
    expect(hit.status).toBe(200);
    expect(JSON.stringify(hit.body)).toContain(`ZINT Venue ${RUN}`);

    const tooBig = await request(app)
      .get("/api/venues")
      .query({ capacityMin: 100000 })
      .set("Authorization", coordAuth());
    expect(JSON.stringify(tooBig.body)).not.toContain(`ZINT Venue ${RUN}`);

    const filters = await request(app).get("/api/venues/filters").set("Authorization", coordAuth());
    expect(filters.status).toBe(200);
    expect(filters.body.locations).toContain("ZINT Test Campus");
  });

  it("a venue marked Unavailable drops out of search", async () => {
    await supabaseAdmin.from("venues").update({ status: "Unavailable" }).eq("id", venueId);

    const res = await request(app).get("/api/venues").set("Authorization", coordAuth());
    expect(JSON.stringify(res.body)).not.toContain(`ZINT Venue ${RUN}`);
  });
});
