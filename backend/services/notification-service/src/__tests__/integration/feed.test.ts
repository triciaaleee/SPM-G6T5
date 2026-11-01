/**
 * Real-DB integration: the REST feed through the real app and the real
 * requireAuth, with tokens signed the way user-service signs them. Rows carry
 * explicit created_at values so the ordering doesn't depend on insert timing.
 */
import "../../lib/env.js";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../../app.js";
import { supabaseAdmin } from "../../lib/supabaseAdmin.js";
import { recipient, teardown } from "./helpers.js";

const URL = "/api/notifications";
const OWNER = recipient("feed-owner");
const OTHER = recipient("feed-other");

const auth = (id: string) => `Bearer ${jwt.sign({ sub: id, role: "coordinator" }, process.env.JWT_SECRET!, { expiresIn: "1h" })}`;

async function seed(rows: { recipient_id: string; title: string; created_at: string }[]): Promise<number[]> {
  const { data, error } = await supabaseAdmin
    .from("notifications")
    .insert(rows.map((r) => ({ type: "zint.test", body: "b", ...r })))
    .select("id");
  if (error || !data) throw new Error(`Failed to seed notifications: ${error?.message}`);
  return data.map((r) => r.id);
}

async function readAtOf(id: number): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("notifications").select("read_at").eq("id", id).single();
  if (error) throw new Error(`Failed to read notification: ${error.message}`);
  return data.read_at;
}

describe("notification feed (real Supabase project)", () => {
  let oldest: number, middle: number, tied1: number, tied2: number, newest: number, others: number;

  beforeAll(async () => {
    [oldest, middle, tied1, tied2, newest] = await seed([
      { recipient_id: OWNER, title: "oldest", created_at: "2026-01-01T00:00:00Z" },
      { recipient_id: OWNER, title: "middle", created_at: "2026-01-02T00:00:00Z" },
      { recipient_id: OWNER, title: "tied-1", created_at: "2026-01-03T00:00:00Z" },
      { recipient_id: OWNER, title: "tied-2", created_at: "2026-01-03T00:00:00Z" },
      { recipient_id: OWNER, title: "newest", created_at: "2026-01-04T00:00:00Z" },
    ]);
    [others] = await seed([{ recipient_id: OTHER, title: "someone else's", created_at: "2026-01-05T00:00:00Z" }]);
  });
  afterAll(teardown);

  it("refuses a request with no token and one with a forged token", async () => {
    expect((await request(app).get(URL)).status).toBe(401);
    const forged = jwt.sign({ sub: OWNER, role: "coordinator" }, `${process.env.JWT_SECRET}-forged`);
    expect((await request(app).get(URL).set("Authorization", `Bearer ${forged}`)).status).toBe(401);
  });

  it("lists only the caller's rows, newest first, breaking ties by id", async () => {
    const res = await request(app).get(`${URL}?limit=50`).set("Authorization", auth(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.notifications.map((n: { title: string }) => n.title)).toEqual(["newest", "tied-2", "tied-1", "middle", "oldest"]);
    expect(res.body.unreadCount).toBe(5);
    expect(res.body.nextCursor).toBeNull();
  });

  it("pages through everything with nextCursor, without repeats or gaps", async () => {
    const page1 = await request(app).get(`${URL}?limit=2`).set("Authorization", auth(OWNER));
    expect(page1.body.notifications.map((n: { id: number }) => n.id)).toEqual([newest, tied2]);
    expect(page1.body.nextCursor).toBe(tied2);
    expect(page1.body.unreadCount).toBe(5);

    const page2 = await request(app).get(`${URL}?limit=2&before=${page1.body.nextCursor}`).set("Authorization", auth(OWNER));
    expect(page2.body.notifications.map((n: { id: number }) => n.id)).toEqual([tied1, middle]);
    expect(page2.body).not.toHaveProperty("unreadCount");

    const page3 = await request(app).get(`${URL}?limit=2&before=${page2.body.nextCursor}`).set("Authorization", auth(OWNER));
    expect(page3.body.notifications.map((n: { id: number }) => n.id)).toEqual([oldest]);
    expect(page3.body.nextCursor).toBeNull();
  });

  it("marking someone else's notification read is a no-op that still answers 204", async () => {
    const res = await request(app).post(`${URL}/${others}/read`).set("Authorization", auth(OWNER));

    expect(res.status).toBe(204);
    expect(await readAtOf(others)).toBeNull();
  });

  it("marks one notification read, and doesn't move read_at when it is marked again", async () => {
    expect((await request(app).post(`${URL}/${oldest}/read`).set("Authorization", auth(OWNER))).status).toBe(204);
    const first = await readAtOf(oldest);
    expect(first).not.toBeNull();

    await supabaseAdmin.from("notifications").update({ read_at: "2026-02-01T00:00:00Z" }).eq("id", oldest);
    expect((await request(app).post(`${URL}/${oldest}/read`).set("Authorization", auth(OWNER))).status).toBe(204);
    expect(new Date((await readAtOf(oldest))!).toISOString()).toBe("2026-02-01T00:00:00.000Z");

    const list = await request(app).get(`${URL}?limit=50`).set("Authorization", auth(OWNER));
    expect(list.body.unreadCount).toBe(4);
    expect(list.body.notifications.find((n: { id: number }) => n.id === oldest).read).toBe(true);
  });

  it("the largest id it accepts reaches Postgres without an error, and a bigger one is refused first", async () => {
    expect((await request(app).post(`${URL}/${Number.MAX_SAFE_INTEGER}/read`).set("Authorization", auth(OWNER))).status).toBe(204);
    expect((await request(app).post(`${URL}/1e30/read`).set("Authorization", auth(OWNER))).status).toBe(400);
    expect((await request(app).get(`${URL}?before=1e30`).set("Authorization", auth(OWNER))).status).toBe(200);
  });

  it("marks all of the caller's notifications read, and nobody else's", async () => {
    expect((await request(app).post(`${URL}/read`).set("Authorization", auth(OWNER))).status).toBe(204);

    const list = await request(app).get(`${URL}?limit=50`).set("Authorization", auth(OWNER));
    expect(list.body.unreadCount).toBe(0);
    expect(await readAtOf(others)).toBeNull();
    expect(await readAtOf(newest)).not.toBeNull();
    expect(await readAtOf(middle)).not.toBeNull();
  });
});
