/**
 * Real-DB integration: block-out periods (E4-3) on a venue with no
 * bookings, so no other service is involved. Checks the date/time check
 * constraints and the cascade-free create → list → edit → remove cycle.
 */
import "../../lib/env.js";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signToken } from "../../lib/jwt.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { unavailabilityRouter } from "../../routes/unavailability.js";
import { RUN, STAFF_ID, seedUsers, teardown } from "./helpers.js";

const app = express();
app.use(express.json());
app.use("/api/venues/unavailability", unavailabilityRouter);

const auth = () => `Bearer ${signToken({ sub: STAFF_ID, role: "venue_staff" })}`;
const URL = "/api/venues/unavailability";

describe("venue unavailability integration (real Supabase project)", () => {
  let venueId: number;
  let periodId: number;

  beforeAll(async () => {
    process.env.JWT_SECRET ||= "integration-secret";
    await seedUsers();
    const { data, error } = await supabaseAdmin
      .from("venues")
      .insert({
        name: `ZINT Block Venue ${RUN}`,
        location: "ZINT Test Campus",
        capacity: 50,
        status: "Available",
        active: true,
        staff_id: STAFF_ID,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Failed to seed venue: ${error?.message}`);
    venueId = data.id;
  });
  afterAll(teardown);

  it("rejects an invalid period and an unknown venue", async () => {
    const bad = await request(app)
      .post(URL)
      .set("Authorization", auth())
      .send({ venueId, startDate: "2031-02-30", reason: "" });
    expect(bad.status).toBe(400);
    expect(bad.body.fields).toHaveProperty("startDate");
    expect(bad.body.fields).toHaveProperty("reason");

    const unknown = await request(app)
      .post(URL)
      .set("Authorization", auth())
      .send({ venueId: 2147483647, startDate: "2031-03-01", reason: "Maintenance" });
    expect(unknown.status).toBe(404);
  });

  it("previews with nothing affected, without writing", async () => {
    const res = await request(app)
      .post(`${URL}/preview`)
      .set("Authorization", auth())
      .send({ venueId, startDate: "2031-03-01", endDate: "2031-03-03", reason: "Maintenance" });

    expect(res.status).toBe(200);
    expect(res.body.affected).toEqual([]);
    const { data } = await supabaseAdmin.from("venue_unavailability").select("id").eq("venue_id", venueId);
    expect(data).toEqual([]);
  });

  it("creates an all-day block-out and persists it", async () => {
    const res = await request(app)
      .post(URL)
      .set("Authorization", auth())
      .send({ venueId, startDate: "2031-03-01", endDate: "2031-03-03", reason: "Renovation" });

    expect(res.status).toBe(201);
    expect(res.body.affected).toEqual([]);
    periodId = res.body.period.id;

    const { data } = await supabaseAdmin
      .from("venue_unavailability")
      .select("start_date, end_date, all_day, reason, created_by")
      .eq("id", periodId)
      .single();
    expect(data).toEqual({
      start_date: "2031-03-01",
      end_date: "2031-03-03",
      all_day: true,
      reason: "Renovation",
      created_by: STAFF_ID,
    });
  });

  it("lists periods inside a range, not outside it, and everything with no range", async () => {
    const inside = await request(app)
      .get(URL)
      .query({ venueId, from: "2031-03-02", to: "2031-03-10" })
      .set("Authorization", auth());
    expect(inside.body.periods.map((p: { id: number }) => p.id)).toEqual([periodId]);

    const outside = await request(app)
      .get(URL)
      .query({ venueId, from: "2031-04-01", to: "2031-04-10" })
      .set("Authorization", auth());
    expect(outside.body.periods).toEqual([]);

    const all = await request(app).get(URL).query({ venueId }).set("Authorization", auth());
    expect(all.body.periods).toHaveLength(1);

    const tooWide = await request(app)
      .get(URL)
      .query({ venueId, from: "2031-01-01", to: "2031-12-31" })
      .set("Authorization", auth());
    expect(tooWide.status).toBe(400);
  });

  it("edits the period into a daily 09:00–13:00 block", async () => {
    const res = await request(app)
      .put(`${URL}/${periodId}`)
      .set("Authorization", auth())
      .send({
        startDate: "2031-03-01",
        endDate: "2031-03-07",
        allDay: false,
        startTime: "09:00",
        endTime: "13:00",
        reason: "Equipment failure",
      });

    expect(res.status).toBe(200);
    const { data } = await supabaseAdmin
      .from("venue_unavailability")
      .select("all_day, start_time, end_time, reason")
      .eq("id", periodId)
      .single();
    expect(data).toMatchObject({ all_day: false, reason: "Equipment failure" });
    expect(data?.start_time?.slice(0, 5)).toBe("09:00");
    expect(data?.end_time?.slice(0, 5)).toBe("13:00");

    const missing = await request(app)
      .put(`${URL}/2147483647`)
      .set("Authorization", auth())
      .send({ startDate: "2031-03-01", reason: "x" });
    expect(missing.status).toBe(404);
  });

  it("removes the period, then 404s on a second removal", async () => {
    expect((await request(app).delete(`${URL}/${periodId}`).set("Authorization", auth())).status).toBe(204);
    const { data } = await supabaseAdmin.from("venue_unavailability").select("id").eq("id", periodId);
    expect(data).toEqual([]);
    expect((await request(app).delete(`${URL}/${periodId}`).set("Authorization", auth())).status).toBe(404);
    expect((await request(app).delete(`${URL}/abc`).set("Authorization", auth())).status).toBe(400);
  });
});
