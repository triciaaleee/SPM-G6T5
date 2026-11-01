/**
 * Exact-contract tests for the routes: for each scenario, the status, the body, every database call (table,
 * operation and arguments) and every message published. They exist to pin down the details a "does it run"
 * test cannot see - an error message, a column list, a filter value, a history entry, a payload - so that a
 * change to any of them has to be made on purpose.
 *
 * The expected values are inline snapshots. Each one was read and checked against the route's code and its
 * story/AGENTS.md rules when it was written; when a route changes on purpose, review the diff before updating.
 */
import express from "express";
import { dispatch } from "./inject.js";
import { signWithClock } from "./tokens.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";
import { attendeeAccessibility } from "../routes/events/registration.js";
import { publicEventsRouter } from "../routes/publicEvents.js";
import { setPublisherForTest, type OutboundMessage } from "../lib/rabbitPublisher.js";
import { setClockForTest } from "../lib/clock.js";

// The one route that brings its own database client (arrangements-changed) gets the same recording database.
vi.mock("../lib/supabaseAdmin.js", () => ({
  supabaseAdmin: { from: (table: string) => (globalThis as any).__mockSupabase.from(table) },
}));

vi.mock("../middleware/auth.js", async () => {
  const applyMock = (req: AuthedRequest, _res: unknown, next: () => void) => {
    req.user = (globalThis as any).__mockUser;
    req.supabase = (globalThis as any).__mockSupabase;
    next();
  };
  return { requireAuth: applyMock, requireAuthOrInternal: applyMock };
});

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

interface Call {
  table: string;
  ops: [string, unknown[]][];
}
interface Reply {
  data?: unknown;
  error?: unknown;
  count?: number;
}
/** Keyed by "<table>.<first operation>", e.g. "events.select" or "change_request_fields.upsert". */
type Responder = Record<string, Reply | ((call: Call) => Reply)>;

const show = (value: unknown): string => JSON.stringify(value) ?? "undefined";
const render = (call: Call): string => `${call.table}.${call.ops.map(([name, args]) => `${name}(${args.map(show).join(", ")})`).join(".")}`;

function makeDb(responder: Responder, log: string[]) {
  function chain(table: string) {
    const call: Call = { table, ops: [] };
    const proxy: any = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: any, reject: any) => {
            log.push(render(call));
            const handler = responder[`${table}.${call.ops[0]?.[0]}`];
            const reply = typeof handler === "function" ? handler(call) : (handler ?? {});
            return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null, count: reply.count ?? null }).then(resolve, reject);
          };
        }
        return (...args: unknown[]) => {
          call.ops.push([String(prop), args]);
          return proxy;
        };
      },
    });
    return proxy;
  }
  /** supabase.rpc(name, args): logged as `rpc.<name>(<args>)`, answered from the responder's "rpc.<name>" entry. */
  function rpc(name: string, args: unknown) {
    log.push(`rpc.${name}(${show(args)})`);
    const handler = responder[`rpc.${name}`];
    const reply = typeof handler === "function" ? handler({ table: "rpc", ops: [[name, [args]]] }) : (handler ?? {});
    return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null });
  }
  return { from: (table: string) => chain(table), rpc };
}

const organiser = { id: "ORG-1", role: "organiser" };
const coordinator = { id: "COORD-1", role: "coordinator" };

const details = {
  name: "Film Night",
  purpose: "Social",
  description: "Movies",
  proposedDate: "2099-06-01",
  startTime: "10:00",
  endTime: "12:00",
  expectedAttendance: 30,
  venue: "Hall",
  accessibility: "Ramp",
  equipment: "Projector",
  technicalSupport: "Tech",
  registrationNeeded: true,
};

const eventRow = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  status: "Confirmed",
  organiser_id: organiser.id,
  coordinator_id: coordinator.id,
  submitted_details: details,
  ...overrides,
});

interface Outcome {
  status: number;
  body: unknown;
  calls: string[];
  published: unknown[];
}

const app = express();
app.use(express.json());
app.use("/api/events/public", publicEventsRouter);
app.use("/api/events", eventsRouter);
/** Anything a handler throws ends up here; send() fails the test if there is any, even when the reply was already sent. */
const thrown: unknown[] = [];
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  thrown.push(err);
  if (res.headersSent) return;
  next(err);
});
const messages: OutboundMessage[] = [];
let publishResult = true;

afterAll(() => {
  setPublisherForTest(undefined);
});
beforeEach(() => {
  messages.length = 0;
  publishResult = true;
  setPublisherForTest({
    publish: async (msg) => {
      messages.push(msg);
      return publishResult;
    },
  });
  setClockForTest("2026-01-01T00:00:00.000Z");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function send(
  method: "get" | "post" | "patch" | "put" | "delete",
  url: string,
  options: { user?: { id: string; role: string } | null; body?: unknown; reply?: Responder; publishOk?: boolean; noClient?: boolean; authorization?: string; headers?: Record<string, string> } = {},
): Promise<Outcome> {
  const calls: string[] = [];
  messages.length = 0;
  (globalThis as any).__mockUser = options.user === null ? undefined : (options.user ?? organiser);
  (globalThis as any).__mockSupabase = options.noClient ? undefined : makeDb(options.reply ?? {}, calls);
  publishResult = options.publishOk ?? true;
  thrown.length = 0;
  const res = await dispatch(app, method, url, {
    headers: { ...(options.authorization ? { Authorization: options.authorization } : {}), ...options.headers },
    body: options.body,
  });
  expect(thrown, "a handler threw").toEqual([]);
  return { status: res.status, body: res.body, calls, published: messages.map(({ type, eventId, actorId, recipients, data }) => ({ type, eventId, actorId, recipients, data })) };
}

// ---------------------------------------------------------------------------------------------
// POST /:id/change-requests  (E3-8, E3-9)
// ---------------------------------------------------------------------------------------------

describe("POST /api/events/:id/change-requests", () => {
  const post = (body: unknown, options: Parameters<typeof send>[2] = {}) => send("post", "/api/events/7/change-requests", { body, ...options });
  const confirmed = (overrides: Record<string, unknown> = {}): Responder => ({ "events.select": { data: eventRow(overrides) } });

  it("turns away a caller with no user or no client", async () => {
    expect(await post({}, { user: null })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Unauthenticated",
        },
        "calls": [],
        "published": [],
        "status": 401,
      }
    `);
    expect(await post({}, { noClient: true })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Unauthenticated",
        },
        "calls": [],
        "published": [],
        "status": 401,
      }
    `);
  });

  it("404s a malformed or unknown event, 500s a failed lookup, 403s someone else's event", async () => {
    expect(await send("post", "/api/events/abc/change-requests", { body: {} })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Event not found",
        },
        "calls": [],
        "published": [],
        "status": 404,
      }
    `);
    expect(await post({}, { reply: {} })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Event not found",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
        ],
        "published": [],
        "status": 404,
      }
    `);
    expect(await post({}, { reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to load event",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
        ],
        "published": [],
        "status": 500,
      }
    `);
    expect(await post({}, { reply: confirmed({ organiser_id: "ORG-2" }) })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Access denied",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "access_denials.insert({"user_id":"ORG-1","event_id":"7","reason":"not_found_or_not_owner"})",
        ],
        "published": [],
        "status": 403,
      }
    `);
  });

  it("only works once the event is Confirmed or Needs Review", async () => {
    for (const status of ["Draft", "Unassigned", "Requested", "Clarification Requested", "Planning", "Safety Review", "Completed", "Rejected", "Cancelled"]) {
      const outcome = await post({ venue: "Other" }, { reply: confirmed({ status }) });
      expect([status, outcome.status, outcome.calls.length, outcome.published.length]).toEqual([status, 409, 1, 0]);
    }
    expect(await post({ venue: "Other" }, { reply: confirmed({ status: "Planning" }) })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Change requests can only be raised once the event is Confirmed.",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
        ],
        "published": [],
        "status": 409,
      }
    `);
  });

  it("500s when the open request or its fields cannot be read", async () => {
    expect(await post({ venue: "Other" }, { reply: { ...confirmed(), "change_requests.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to load the event's open change request",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
        ],
        "published": [],
        "status": 500,
      }
    `);
    expect(
      await post(
        { venue: "Other" },
        { reply: { ...confirmed(), "change_requests.select": { data: { id: 3 } }, "change_request_fields.select": { error: { message: "x" } } } },
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to load the event's open change request",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_request_fields.select("id, field, old_value, new_value, is_critical").eq("request_id", 3)",
        ],
        "published": [],
        "status": 500,
      }
    `);
  });

  it("rejects invalid fields, and a request that changes nothing", async () => {
    expect(await post({ venue: "", expectedAttendance: 0 }, { reply: confirmed() })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Validation failed",
          "fields": {
            "expectedAttendance": "Expected attendance must be greater than zero.",
            "venue": "This field is required.",
          },
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
        ],
        "published": [],
        "status": 400,
      }
    `);
    expect(await post({ venue: "Hall" }, { reply: confirmed() })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "No field changes were submitted.",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
        ],
        "published": [],
        "status": 400,
      }
    `);
    expect(await post(undefined, { reply: confirmed() })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "No field changes were submitted.",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
        ],
        "published": [],
        "status": 400,
      }
    `);
  });

  it("holds a critical change: new Pending request, Confirmed -> Needs Review, coordinator told", async () => {
    expect(
      await post(
        { venue: "Other hall" },
        { reply: { ...confirmed(), "change_requests.insert": { data: { id: 11 } } } },
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "applied": [],
          "autoResolved": false,
          "changeRequestId": 11,
          "held": [
            "venue",
          ],
          "notificationsFailed": false,
          "reverted": [],
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_requests.insert({"event_id":7,"organiser_id":"ORG-1","status":"Pending","decided_at":null,"decision_reason":null}).select("id").single()",
          "change_request_fields.upsert([{"request_id":11,"field":"venue","old_value":"Hall","new_value":"Other hall","is_critical":true}], {"onConflict":"request_id,field"})",
          "events.update({"status":"Needs Review"}).eq("id", 7).eq("status", "Confirmed")",
          "event_history.insert([{"event_id":7,"field":"venue","old_value":"Hall","new_value":"requested: Other hall (pending coordinator review)","changed_by":"ORG-1"}])",
          "event_history.insert([{"event_id":7,"field":"Status","old_value":"Confirmed","new_value":"Needs Review","changed_by":"ORG-1"}])",
        ],
        "published": [
          {
            "actorId": "ORG-1",
            "data": {
              "changeRequestId": 11,
              "eventName": "Film Night",
              "fields": [
                "venue",
              ],
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "COORD-1",
              ],
            },
            "type": "change.requested",
          },
        ],
        "status": 201,
      }
    `);
  });

  it("holds a critical change on a Needs Review event without touching its status", async () => {
    expect(
      await post(
        { expectedAttendance: 45 },
        { reply: { ...confirmed({ status: "Needs Review" }), "change_requests.insert": { data: { id: 11 } } } },
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "applied": [],
          "autoResolved": false,
          "changeRequestId": 11,
          "held": [
            "expectedAttendance",
          ],
          "notificationsFailed": false,
          "reverted": [],
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_requests.insert({"event_id":7,"organiser_id":"ORG-1","status":"Pending","decided_at":null,"decision_reason":null}).select("id").single()",
          "change_request_fields.upsert([{"request_id":11,"field":"expectedAttendance","old_value":"30","new_value":"45","is_critical":true}], {"onConflict":"request_id,field"})",
          "event_history.insert([{"event_id":7,"field":"expectedAttendance","old_value":"30","new_value":"requested: 45 (pending coordinator review)","changed_by":"ORG-1"}])",
        ],
        "published": [
          {
            "actorId": "ORG-1",
            "data": {
              "changeRequestId": 11,
              "eventName": "Film Night",
              "fields": [
                "expectedAttendance",
              ],
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "COORD-1",
              ],
            },
            "type": "change.requested",
          },
        ],
        "status": 201,
      }
    `);
  });

  it("applies non-critical changes at once as an already-approved automatic request", async () => {
    expect(
      await post(
        { name: "  Film Night II  ", purpose: "Fun", registrationNeeded: false },
        { reply: { ...confirmed(), "change_requests.insert": { data: { id: 12 } } } },
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "applied": [
            "name",
            "purpose",
            "registrationNeeded",
          ],
          "autoResolved": false,
          "changeRequestId": 12,
          "held": [],
          "notificationsFailed": false,
          "reverted": [],
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_requests.insert({"event_id":7,"organiser_id":"ORG-1","status":"Approved","decided_at":"2026-01-01T00:00:00.000Z","decision_reason":"Applied automatically — name, purpose, registrationNeeded"}).select("id").single()",
          "change_request_fields.upsert([{"request_id":12,"field":"name","old_value":"Film Night","new_value":"Film Night II","is_critical":false},{"request_id":12,"field":"purpose","old_value":"Social","new_value":"Fun","is_critical":false},{"request_id":12,"field":"registrationNeeded","old_value":"Yes","new_value":"No","is_critical":false}], {"onConflict":"request_id,field"})",
          "events.update({"submitted_details":{"name":"Film Night II","purpose":"Fun","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":false}}).eq("id", 7)",
          "event_history.insert([{"event_id":7,"field":"name","old_value":"Film Night","new_value":"Film Night II","changed_by":"ORG-1"},{"event_id":7,"field":"purpose","old_value":"Social","new_value":"Fun","changed_by":"ORG-1"},{"event_id":7,"field":"registrationNeeded","old_value":"Yes","new_value":"No","changed_by":"ORG-1"}])",
        ],
        "published": [
          {
            "actorId": "ORG-1",
            "data": {
              "changeRequestId": 12,
              "eventName": "Film Night",
              "fields": [
                "name",
                "purpose",
                "registrationNeeded",
              ],
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "COORD-1",
              ],
            },
            "type": "change.requested",
          },
        ],
        "status": 201,
      }
    `);
    const turnedOn = await post(
      { registrationNeeded: "true" },
      { reply: { ...confirmed({ submitted_details: { ...details, registrationNeeded: false } }), "change_requests.insert": { data: { id: 12 } } } },
    );
    expect(turnedOn).toMatchInlineSnapshot(`
      {
        "body": {
          "applied": [
            "registrationNeeded",
          ],
          "autoResolved": false,
          "changeRequestId": 12,
          "held": [],
          "notificationsFailed": false,
          "reverted": [],
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_requests.insert({"event_id":7,"organiser_id":"ORG-1","status":"Approved","decided_at":"2026-01-01T00:00:00.000Z","decision_reason":"Applied automatically — registrationNeeded"}).select("id").single()",
          "change_request_fields.upsert([{"request_id":12,"field":"registrationNeeded","old_value":"No","new_value":"Yes","is_critical":false}], {"onConflict":"request_id,field"})",
          "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).eq("id", 7)",
          "event_history.insert([{"event_id":7,"field":"registrationNeeded","old_value":"No","new_value":"Yes","changed_by":"ORG-1"}])",
        ],
        "published": [
          {
            "actorId": "ORG-1",
            "data": {
              "changeRequestId": 12,
              "eventName": "Film Night",
              "fields": [
                "registrationNeeded",
              ],
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "COORD-1",
              ],
            },
            "type": "change.requested",
          },
        ],
        "status": 201,
      }
    `);
  });

  it("splits a mixed request into one held and one applied part", async () => {
    expect(
      await post(
        { venue: "Other hall", description: "New text" },
        { reply: { ...confirmed(), "change_requests.insert": { data: { id: 13 } } } },
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "applied": [
            "description",
          ],
          "autoResolved": false,
          "changeRequestId": 13,
          "held": [
            "venue",
          ],
          "notificationsFailed": false,
          "reverted": [],
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_requests.insert({"event_id":7,"organiser_id":"ORG-1","status":"Pending","decided_at":null,"decision_reason":null}).select("id").single()",
          "change_request_fields.upsert([{"request_id":13,"field":"venue","old_value":"Hall","new_value":"Other hall","is_critical":true},{"request_id":13,"field":"description","old_value":"Movies","new_value":"New text","is_critical":false}], {"onConflict":"request_id,field"})",
          "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"New text","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).eq("id", 7)",
          "events.update({"status":"Needs Review"}).eq("id", 7).eq("status", "Confirmed")",
          "event_history.insert([{"event_id":7,"field":"description","old_value":"Movies","new_value":"New text","changed_by":"ORG-1"}])",
          "event_history.insert([{"event_id":7,"field":"venue","old_value":"Hall","new_value":"requested: Other hall (pending coordinator review)","changed_by":"ORG-1"}])",
          "event_history.insert([{"event_id":7,"field":"Status","old_value":"Confirmed","new_value":"Needs Review","changed_by":"ORG-1"}])",
        ],
        "published": [
          {
            "actorId": "ORG-1",
            "data": {
              "changeRequestId": 13,
              "eventName": "Film Night",
              "fields": [
                "description",
                "venue",
              ],
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "COORD-1",
              ],
            },
            "type": "change.requested",
          },
        ],
        "status": 201,
      }
    `);
  });

  it("merges into the open request: overwrites a held value and keeps the rest", async () => {
    expect(
      await post(
        { venue: "Third hall" },
        {
          reply: {
            ...confirmed({ status: "Needs Review" }),
            "change_requests.select": { data: { id: 3 } },
            "change_request_fields.select": {
              data: [
                { id: 1, field: "venue", old_value: "Hall", new_value: "Other hall", is_critical: true },
                { id: 2, field: "expectedAttendance", old_value: "30", new_value: "45", is_critical: true },
              ],
            },
          },
        },
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "applied": [],
          "autoResolved": false,
          "changeRequestId": 3,
          "held": [
            "venue",
          ],
          "notificationsFailed": false,
          "reverted": [],
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_request_fields.select("id, field, old_value, new_value, is_critical").eq("request_id", 3)",
          "change_request_fields.upsert([{"request_id":3,"field":"venue","old_value":"Hall","new_value":"Third hall","is_critical":true}], {"onConflict":"request_id,field"})",
          "event_history.insert([{"event_id":7,"field":"venue","old_value":"Hall","new_value":"requested: Third hall (pending coordinator review)","changed_by":"ORG-1"}])",
        ],
        "published": [
          {
            "actorId": "ORG-1",
            "data": {
              "changeRequestId": 3,
              "eventName": "Film Night",
              "fields": [
                "venue",
              ],
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "COORD-1",
              ],
            },
            "type": "change.requested",
          },
        ],
        "status": 201,
      }
    `);
  });

  it("reverting one of two held fields un-holds just that one", async () => {
    expect(
      await post(
        { venue: "Hall" },
        {
          reply: {
            ...confirmed({ status: "Needs Review" }),
            "change_requests.select": { data: { id: 3 } },
            "change_request_fields.select": {
              data: [
                { id: 1, field: "venue", old_value: "Hall", new_value: "Other hall", is_critical: true },
                { id: 2, field: "expectedAttendance", old_value: "30", new_value: "45", is_critical: true },
              ],
            },
          },
        },
      ),
    ).toMatchInlineSnapshot(`
      {
        "body": {
          "applied": [],
          "autoResolved": false,
          "changeRequestId": 3,
          "held": [],
          "notificationsFailed": false,
          "reverted": [
            "venue",
          ],
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_request_fields.select("id, field, old_value, new_value, is_critical").eq("request_id", 3)",
          "change_request_fields.delete().eq("request_id", 3).in("field", ["venue"])",
          "event_history.insert([{"event_id":7,"field":"venue","old_value":"Other hall","new_value":"reverted to Hall (no longer pending)","changed_by":"ORG-1"}])",
        ],
        "published": [
          {
            "actorId": "ORG-1",
            "data": {
              "changeRequestId": 3,
              "eventName": "Film Night",
              "fields": [
                "venue",
              ],
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "COORD-1",
              ],
            },
            "type": "change.requested",
          },
        ],
        "status": 201,
      }
    `);
  });

  it("reverting the only held field closes the request as Auto-Withdrawn and tells both sides", async () => {
    const reply: Responder = {
      ...confirmed({ status: "Needs Review" }),
      "change_requests.select": { data: { id: 3 } },
      "change_request_fields.select": { data: [{ id: 1, field: "venue", old_value: "Hall", new_value: "Other hall", is_critical: true }] },
    };
    expect(await post({ venue: "Hall" }, { reply })).toMatchInlineSnapshot(`
      {
        "body": {
          "applied": [],
          "autoResolved": true,
          "changeRequestId": 3,
          "held": [],
          "notificationsFailed": false,
          "reverted": [
            "venue",
          ],
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_request_fields.select("id, field, old_value, new_value, is_critical").eq("request_id", 3)",
          "change_request_fields.delete().eq("request_id", 3).in("field", ["venue"])",
          "event_history.insert([{"event_id":7,"field":"venue","old_value":"Other hall","new_value":"reverted to Hall (no longer pending)","changed_by":"ORG-1"}])",
          "change_requests.update({"status":"Auto-Withdrawn","decided_at":"2026-01-01T00:00:00.000Z","decided_by":null,"decision_reason":"The requested change to venue was reverted before it was reviewed."}).eq("id", 3)",
        ],
        "published": [
          {
            "actorId": "ORG-1",
            "data": {
              "changeRequestId": 3,
              "eventName": "Film Night",
              "fields": [
                "venue",
              ],
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "ORG-1",
                "COORD-1",
              ],
            },
            "type": "change.withdrawn",
          },
        ],
        "status": 201,
      }
    `);
    expect(await post({ venue: "Hall" }, { reply: { ...reply, "events.select": { data: eventRow({ status: "Needs Review", coordinator_id: null }) } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "applied": [],
          "autoResolved": true,
          "changeRequestId": 3,
          "held": [],
          "notificationsFailed": false,
          "reverted": [
            "venue",
          ],
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_request_fields.select("id, field, old_value, new_value, is_critical").eq("request_id", 3)",
          "change_request_fields.delete().eq("request_id", 3).in("field", ["venue"])",
          "event_history.insert([{"event_id":7,"field":"venue","old_value":"Other hall","new_value":"reverted to Hall (no longer pending)","changed_by":"ORG-1"}])",
          "change_requests.update({"status":"Auto-Withdrawn","decided_at":"2026-01-01T00:00:00.000Z","decided_by":null,"decision_reason":"The requested change to venue was reverted before it was reviewed."}).eq("id", 3)",
        ],
        "published": [
          {
            "actorId": "ORG-1",
            "data": {
              "changeRequestId": 3,
              "eventName": "Film Night",
              "fields": [
                "venue",
              ],
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "ORG-1",
              ],
            },
            "type": "change.withdrawn",
          },
        ],
        "status": 201,
      }
    `);
  });

  it("reports a failed notification without failing the request", async () => {
    const reply: Responder = { ...confirmed(), "change_requests.insert": { data: { id: 11 } } };
    expect((await post({ venue: "Other hall" }, { reply, publishOk: false })).body).toMatchInlineSnapshot(`
      {
        "applied": [],
        "autoResolved": false,
        "changeRequestId": 11,
        "held": [
          "venue",
        ],
        "notificationsFailed": true,
        "reverted": [],
      }
    `);
    const withdraw: Responder = {
      ...confirmed({ status: "Needs Review" }),
      "change_requests.select": { data: { id: 3 } },
      "change_request_fields.select": { data: [{ id: 1, field: "venue", old_value: "Hall", new_value: "Other hall", is_critical: true }] },
    };
    expect((await post({ venue: "Hall" }, { reply: withdraw, publishOk: false })).body).toMatchInlineSnapshot(`
      {
        "applied": [],
        "autoResolved": true,
        "changeRequestId": 3,
        "held": [],
        "notificationsFailed": true,
        "reverted": [
          "venue",
        ],
      }
    `);
  });

  it("sends no notification when nobody is assigned to be told", async () => {
    const outcome = await post(
      { venue: "Other hall" },
      { reply: { ...confirmed({ coordinator_id: null }), "change_requests.insert": { data: { id: 11 } } } },
    );
    expect(outcome.published).toEqual([]);
    expect(outcome.body).toMatchObject({ notificationsFailed: false });
  });

  it("answers 500 at each write that can fail, and stops there", async () => {
    const base: Responder = { ...confirmed(), "change_requests.insert": { data: { id: 11 } } };
    const failing = (key: string, body: Record<string, unknown>, extra: Responder = {}) =>
      post(body, { reply: { ...base, ...extra, [key]: { error: { message: "x" } } } });
    expect(await post({ venue: "Other hall" }, { reply: { ...base, "change_requests.insert": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to raise change request",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_requests.insert({"event_id":7,"organiser_id":"ORG-1","status":"Pending","decided_at":null,"decision_reason":null}).select("id").single()",
        ],
        "published": [],
        "status": 500,
      }
    `);
    expect(await post({ venue: "Other hall" }, { reply: { ...base, "change_requests.insert": { data: null } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to raise change request",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_requests.insert({"event_id":7,"organiser_id":"ORG-1","status":"Pending","decided_at":null,"decision_reason":null}).select("id").single()",
        ],
        "published": [],
        "status": 500,
      }
    `);
    expect(await failing("change_request_fields.upsert", { venue: "Other hall" })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to raise change request",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_requests.insert({"event_id":7,"organiser_id":"ORG-1","status":"Pending","decided_at":null,"decision_reason":null}).select("id").single()",
          "change_request_fields.upsert([{"request_id":11,"field":"venue","old_value":"Hall","new_value":"Other hall","is_critical":true}], {"onConflict":"request_id,field"})",
          "change_requests.delete().eq("id", 11)",
        ],
        "published": [],
        "status": 500,
      }
    `);
    expect(await failing("events.update", { name: "New name" })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to apply change request",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_requests.insert({"event_id":7,"organiser_id":"ORG-1","status":"Approved","decided_at":"2026-01-01T00:00:00.000Z","decision_reason":"Applied automatically — name"}).select("id").single()",
          "change_request_fields.upsert([{"request_id":11,"field":"name","old_value":"Film Night","new_value":"New name","is_critical":false}], {"onConflict":"request_id,field"})",
          "events.update({"submitted_details":{"name":"New name","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).eq("id", 7)",
          "change_requests.delete().eq("id", 11)",
        ],
        "published": [],
        "status": 500,
      }
    `);
    expect(await failing("events.update", { venue: "Other hall" })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to raise change request",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_requests.insert({"event_id":7,"organiser_id":"ORG-1","status":"Pending","decided_at":null,"decision_reason":null}).select("id").single()",
          "change_request_fields.upsert([{"request_id":11,"field":"venue","old_value":"Hall","new_value":"Other hall","is_critical":true}], {"onConflict":"request_id,field"})",
          "events.update({"status":"Needs Review"}).eq("id", 7).eq("status", "Confirmed")",
          "change_requests.delete().eq("id", 11)",
        ],
        "published": [],
        "status": 500,
      }
    `);
    const open: Responder = {
      "change_requests.select": { data: { id: 3 } },
      "change_request_fields.select": { data: [{ id: 1, field: "venue", old_value: "Hall", new_value: "Other hall", is_critical: true }] },
    };
    expect(await failing("change_request_fields.delete", { venue: "Hall" }, { ...open, ...confirmed({ status: "Needs Review" }) })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to raise change request",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_request_fields.select("id, field, old_value, new_value, is_critical").eq("request_id", 3)",
          "change_request_fields.delete().eq("request_id", 3).in("field", ["venue"])",
          "change_request_fields.upsert([{"request_id":3,"field":"venue","old_value":"Hall","new_value":"Other hall","is_critical":true}], {"onConflict":"request_id,field"})",
        ],
        "published": [],
        "status": 500,
      }
    `);
    expect(await failing("change_requests.update", { venue: "Hall" }, { ...open, ...confirmed({ status: "Needs Review" }) })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to raise change request",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_request_fields.select("id, field, old_value, new_value, is_critical").eq("request_id", 3)",
          "change_request_fields.delete().eq("request_id", 3).in("field", ["venue"])",
          "event_history.insert([{"event_id":7,"field":"venue","old_value":"Other hall","new_value":"reverted to Hall (no longer pending)","changed_by":"ORG-1"}])",
          "change_requests.update({"status":"Auto-Withdrawn","decided_at":"2026-01-01T00:00:00.000Z","decided_by":null,"decision_reason":"The requested change to venue was reverted before it was reviewed."}).eq("id", 3)",
          "change_request_fields.upsert([{"request_id":3,"field":"venue","old_value":"Hall","new_value":"Other hall","is_critical":true}], {"onConflict":"request_id,field"})",
        ],
        "published": [],
        "status": 500,
      }
    `);
  });
});

// ---------------------------------------------------------------------------------------------
// PATCH /:id  (E2-7, E2-10, E2-14, E3-7)
// ---------------------------------------------------------------------------------------------

describe("PATCH /api/events/:id", () => {
  const patch = (body: unknown, options: Parameters<typeof send>[2] = {}) => send("patch", "/api/events/7", { body, ...options });
  const row = (overrides: Record<string, unknown> = {}): Responder => ({
    "events.select": { data: eventRow({ status: "Requested", status_before_clarification: null, ...overrides }) },
    "events.update": { data: { id: 7, submitted_details: details } },
  });
  const rescheduled = { ...details, startTime: "11:00", endTime: "13:00" };
  const biggerCrowd = { ...details, expectedAttendance: 40 };

  it("turns away a caller with no user or no client", async () => {
    expect(await patch(details, { user: null })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Unauthenticated",
        },
        "calls": [],
        "published": [],
        "status": 401,
      }
    `);
    expect(await patch(details, { noClient: true })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Unauthenticated",
        },
        "calls": [],
        "published": [],
        "status": 401,
      }
    `);
  });

  it("404s a malformed or unknown event and 500s a failed lookup", async () => {
    expect(await send("patch", "/api/events/abc", { body: details })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Event not found",
        },
        "calls": [],
        "published": [],
        "status": 404,
      }
    `);
    expect(await patch(details, { reply: {} })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Event not found",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
        ],
        "published": [],
        "status": 404,
      }
    `);
    expect(await patch(details, { reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to load event",
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
        ],
        "published": [],
        "status": 500,
      }
    `);
  });

  describe("as the coordinator (E3-7)", () => {
    it("is refused unless assigned to the event, and the refusal is recorded", async () => {
      expect(await patch(details, { user: coordinator, reply: row({ coordinator_id: "COORD-2", status: "Planning" }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "access_denials.insert({"user_id":"COORD-1","event_id":"7","reason":"not_assigned_coordinator"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
    });

    it("is refused outside Planning", async () => {
      for (const status of ["Unassigned", "Requested", "Clarification Requested", "Safety Review", "Confirmed", "Needs Review", "Completed"]) {
        const outcome = await patch(details, { user: coordinator, reply: row({ status }) });
        expect([status, outcome.status, outcome.calls.length, outcome.published.length]).toEqual([status, 409, 1, 0]);
      }
      expect(await patch(details, { user: coordinator, reply: row({ status: "Confirmed" }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Coordinator edits are only allowed while the event is in Planning.",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });

    it("rejects invalid details with the failing fields", async () => {
      expect(await patch({ ...details, expectedAttendance: 0 }, { user: coordinator, reply: row({ status: "Planning" }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Validation failed",
            "fields": {
              "expectedAttendance": "Expected attendance must be greater than zero.",
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      expect((await patch(undefined, { user: coordinator, reply: row({ status: "Planning" }) })).status).toBe(400);
    });

    it("500s when the save fails, before any history is written", async () => {
      expect(await patch(details, { user: coordinator, reply: { ...row({ status: "Planning" }), "events.update": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to save changes",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("saves an edit that moves nothing the other services track: history only", async () => {
      expect(await patch({ ...details, description: "Short films" }, { user: coordinator, reply: row({ status: "Planning" }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Short films","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_history.insert([{"event_id":7,"field":"Description","old_value":"Movies","new_value":"Short films","changed_by":"COORD-1"}])",
          ],
          "published": [],
          "status": 200,
        }
      `);
    });

    it("announces a new date or time to the services that book against it", async () => {
      expect(await patch(rescheduled, { user: coordinator, reply: row({ status: "Planning" }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"11:00","endTime":"13:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_history.insert([{"event_id":7,"field":"Start time","old_value":"10:00","new_value":"11:00","changed_by":"COORD-1"},{"event_id":7,"field":"End time","old_value":"12:00","new_value":"13:00","changed_by":"COORD-1"}])",
            "event_outbox.insert({"type":"event.rescheduled","event_id":7,"actor_id":"COORD-1","recipients":{"userIds":[],"roles":[]},"data":{"eventName":"Film Night","coordinatorId":"COORD-1","proposedDate":"2099-06-01","startTime":"11:00","endTime":"13:00"}}).select("id, message_id, type, event_id, actor_id, recipients, data, occurred_at").single()",
          ],
          "published": [
            {
              "actorId": "COORD-1",
              "data": {
                "coordinatorId": "COORD-1",
                "endTime": "13:00",
                "eventName": "Film Night",
                "proposedDate": "2099-06-01",
                "startTime": "11:00",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [],
              },
              "type": "event.rescheduled",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("announces a new attendance figure", async () => {
      expect(await patch(biggerCrowd, { user: coordinator, reply: row({ status: "Planning" }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":40,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_history.insert([{"event_id":7,"field":"Expected attendance","old_value":"30","new_value":"40","changed_by":"COORD-1"}])",
            "event_outbox.insert({"type":"event.attendance_changed","event_id":7,"actor_id":"COORD-1","recipients":{"userIds":[],"roles":[]},"data":{"eventName":"Film Night","coordinatorId":"COORD-1","expectedAttendance":40}}).select("id, message_id, type, event_id, actor_id, recipients, data, occurred_at").single()",
          ],
          "published": [
            {
              "actorId": "COORD-1",
              "data": {
                "coordinatorId": "COORD-1",
                "eventName": "Film Night",
                "expectedAttendance": 40,
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [],
              },
              "type": "event.attendance_changed",
            },
          ],
          "status": 200,
        }
      `);
    });
  });

  describe("as the organiser", () => {
    it("is refused on someone else's event, and the refusal is recorded", async () => {
      expect(await patch(details, { reply: row({ organiser_id: "ORG-2" }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "access_denials.insert({"user_id":"ORG-1","event_id":"7","reason":"not_found_or_not_owner"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
    });

    it("is refused once the event is past the editable statuses, with advice that fits", async () => {
      for (const status of ["Safety Review", "Completed", "Rejected", "Cancelled"]) {
        const outcome = await patch(details, { reply: row({ status }) });
        expect([status, outcome.status, outcome.calls.length, outcome.body]).toEqual([
          status,
          409,
          1,
          { error: "This request can no longer be edited or changed at this stage." },
        ]);
      }
      for (const status of ["Confirmed", "Needs Review"]) {
        const outcome = await patch(details, { reply: row({ status }) });
        expect([status, outcome.status, outcome.body]).toEqual([
          status,
          409,
          { error: "This event is past Planning and can no longer be edited directly. Raise a change request instead." },
        ]);
      }
    });

    it("lets only an organiser submit a draft", async () => {
      expect(await patch(details, { user: { id: "ORG-1", role: "attendee" }, reply: row({ status: "Draft" }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Only organisers can submit event requests",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 403,
        }
      `);
    });

    it("rejects invalid details with the failing fields", async () => {
      expect(await patch({ ...details, name: "" }, { reply: row() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Validation failed",
            "fields": {
              "name": "This field is required.",
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      expect((await patch(undefined, { reply: row() })).status).toBe(400);
    });

    it("500s when the save fails", async () => {
      expect(await patch(details, { reply: { ...row(), "events.update": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to save your response",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("edits a Requested event directly: details only, the coordinator is told, nothing is announced", async () => {
      expect(await patch(rescheduled, { reply: row() })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"11:00","endTime":"13:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_history.insert([{"event_id":7,"field":"Start time","old_value":"10:00","new_value":"11:00","changed_by":"ORG-1"},{"event_id":7,"field":"End time","old_value":"12:00","new_value":"13:00","changed_by":"ORG-1"}])",
          ],
          "published": [
            {
              "actorId": "ORG-1",
              "data": {
                "eventName": "Film Night",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "COORD-1",
                ],
              },
              "type": "request.edited",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("tells every Lead about an edit while nobody is assigned", async () => {
      expect(await patch({ ...details, description: "Short films" }, { reply: row({ status: "Unassigned", coordinator_id: null }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Short films","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_history.insert([{"event_id":7,"field":"Description","old_value":"Movies","new_value":"Short films","changed_by":"ORG-1"}])",
          ],
          "published": [
            {
              "actorId": "ORG-1",
              "data": {
                "eventName": "Film Night",
              },
              "eventId": 7,
              "recipients": {
                "roles": [
                  "coordinator_lead",
                ],
                "userIds": [],
              },
              "type": "request.edited",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("announces a new date, time and attendance for a Planning edit", async () => {
      expect(await patch({ ...rescheduled, expectedAttendance: 40 }, { reply: row({ status: "Planning" }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"11:00","endTime":"13:00","expectedAttendance":40,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_history.insert([{"event_id":7,"field":"Start time","old_value":"10:00","new_value":"11:00","changed_by":"ORG-1"},{"event_id":7,"field":"End time","old_value":"12:00","new_value":"13:00","changed_by":"ORG-1"},{"event_id":7,"field":"Expected attendance","old_value":"30","new_value":"40","changed_by":"ORG-1"}])",
            "event_outbox.insert({"type":"event.rescheduled","event_id":7,"actor_id":"ORG-1","recipients":{"userIds":[],"roles":[]},"data":{"eventName":"Film Night","coordinatorId":"COORD-1","proposedDate":"2099-06-01","startTime":"11:00","endTime":"13:00"}}).select("id, message_id, type, event_id, actor_id, recipients, data, occurred_at").single()",
            "event_outbox.insert({"type":"event.attendance_changed","event_id":7,"actor_id":"ORG-1","recipients":{"userIds":[],"roles":[]},"data":{"eventName":"Film Night","coordinatorId":"COORD-1","expectedAttendance":40}}).select("id, message_id, type, event_id, actor_id, recipients, data, occurred_at").single()",
          ],
          "published": [
            {
              "actorId": "ORG-1",
              "data": {
                "coordinatorId": "COORD-1",
                "endTime": "13:00",
                "eventName": "Film Night",
                "proposedDate": "2099-06-01",
                "startTime": "11:00",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [],
              },
              "type": "event.rescheduled",
            },
            {
              "actorId": "ORG-1",
              "data": {
                "coordinatorId": "COORD-1",
                "eventName": "Film Night",
                "expectedAttendance": 40,
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [],
              },
              "type": "event.attendance_changed",
            },
            {
              "actorId": "ORG-1",
              "data": {
                "eventName": "Film Night",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "COORD-1",
                ],
              },
              "type": "request.edited",
            },
          ],
          "status": 200,
        }
      `);
      expect(await patch({ ...details, description: "Short films" }, { reply: row({ status: "Planning", coordinator_id: null }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Short films","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_history.insert([{"event_id":7,"field":"Description","old_value":"Movies","new_value":"Short films","changed_by":"ORG-1"}])",
          ],
          "published": [
            {
              "actorId": "ORG-1",
              "data": {
                "eventName": "Film Night",
              },
              "eventId": 7,
              "recipients": {
                "roles": [
                  "coordinator_lead",
                ],
                "userIds": [],
              },
              "type": "request.edited",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("submits a draft: Unassigned, no coordinator, the Leads are told, no history of a reschedule", async () => {
      expect(await patch(rescheduled, { reply: row({ status: "Draft", coordinator_id: null, submitted_details: {} }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"11:00","endTime":"13:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Unassigned","coordinator_id":null}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_history.insert([{"event_id":7,"field":"Event name","old_value":null,"new_value":"Film Night","changed_by":"ORG-1"},{"event_id":7,"field":"Purpose","old_value":null,"new_value":"Social","changed_by":"ORG-1"},{"event_id":7,"field":"Description","old_value":null,"new_value":"Movies","changed_by":"ORG-1"},{"event_id":7,"field":"Proposed date","old_value":null,"new_value":"2099-06-01","changed_by":"ORG-1"},{"event_id":7,"field":"Start time","old_value":null,"new_value":"11:00","changed_by":"ORG-1"},{"event_id":7,"field":"End time","old_value":null,"new_value":"13:00","changed_by":"ORG-1"},{"event_id":7,"field":"Expected attendance","old_value":null,"new_value":"30","changed_by":"ORG-1"},{"event_id":7,"field":"Venue","old_value":null,"new_value":"Hall","changed_by":"ORG-1"},{"event_id":7,"field":"Accessibility","old_value":null,"new_value":"Ramp","changed_by":"ORG-1"},{"event_id":7,"field":"Equipment","old_value":null,"new_value":"Projector","changed_by":"ORG-1"},{"event_id":7,"field":"Technical support","old_value":null,"new_value":"Tech","changed_by":"ORG-1"},{"event_id":7,"field":"Registration needed","old_value":null,"new_value":"Yes","changed_by":"ORG-1"}])",
          ],
          "published": [
            {
              "actorId": "ORG-1",
              "data": {
                "eventName": "Film Night",
                "organiserId": "ORG-1",
              },
              "eventId": 7,
              "recipients": {
                "roles": [
                  "coordinator_lead",
                ],
                "userIds": [
                  "ORG-1",
                ],
              },
              "type": "request.submitted",
            },
          ],
          "status": 200,
        }
      `);
    });
  });

  describe("answering a clarification (E2-10)", () => {
    const clarifying = (overrides: Record<string, unknown> = {}): Responder => ({
      ...row({ status: "Clarification Requested", status_before_clarification: "Planning", ...overrides }),
      "event_clarifications.select": { data: { id: 55 } },
    });

    it("returns to the status it came from and replies in the thread with what changed", async () => {
      expect(await patch(rescheduled, { reply: clarifying() })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"11:00","endTime":"13:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Planning","status_before_clarification":null}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_history.insert([{"event_id":7,"field":"Start time","old_value":"10:00","new_value":"11:00","changed_by":"ORG-1"},{"event_id":7,"field":"End time","old_value":"12:00","new_value":"13:00","changed_by":"ORG-1"}])",
            "event_outbox.insert({"type":"event.rescheduled","event_id":7,"actor_id":"ORG-1","recipients":{"userIds":[],"roles":[]},"data":{"eventName":"Film Night","coordinatorId":"COORD-1","proposedDate":"2099-06-01","startTime":"11:00","endTime":"13:00"}}).select("id, message_id, type, event_id, actor_id, recipients, data, occurred_at").single()",
            "event_clarifications.select("id").eq("event_id", 7).is("parent_id", null).eq("resolved", false).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
            "event_clarifications.insert({"event_id":7,"parent_id":55,"author_id":"ORG-1","author_role":"organiser","message":"Start time changed from '10:00' to '11:00'\\nEnd time changed from '12:00' to '13:00'"})",
          ],
          "published": [
            {
              "actorId": "ORG-1",
              "data": {
                "coordinatorId": "COORD-1",
                "endTime": "13:00",
                "eventName": "Film Night",
                "proposedDate": "2099-06-01",
                "startTime": "11:00",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [],
              },
              "type": "event.rescheduled",
            },
            {
              "actorId": "ORG-1",
              "data": {
                "eventName": "Film Night",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "COORD-1",
                ],
              },
              "type": "clarification.answered",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("returns to Requested when no earlier status was recorded", async () => {
      expect(await patch(rescheduled, { reply: clarifying({ status_before_clarification: null }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"11:00","endTime":"13:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Requested","status_before_clarification":null}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_history.insert([{"event_id":7,"field":"Start time","old_value":"10:00","new_value":"11:00","changed_by":"ORG-1"},{"event_id":7,"field":"End time","old_value":"12:00","new_value":"13:00","changed_by":"ORG-1"}])",
            "event_clarifications.select("id").eq("event_id", 7).is("parent_id", null).eq("resolved", false).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
            "event_clarifications.insert({"event_id":7,"parent_id":55,"author_id":"ORG-1","author_role":"organiser","message":"Start time changed from '10:00' to '11:00'\\nEnd time changed from '12:00' to '13:00'"})",
          ],
          "published": [
            {
              "actorId": "ORG-1",
              "data": {
                "eventName": "Film Night",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "COORD-1",
                ],
              },
              "type": "clarification.answered",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("posts an unthreaded reply when no question is open, and no reply when nothing changed", async () => {
      expect(await patch(rescheduled, { reply: { ...clarifying(), "event_clarifications.select": { data: null } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"11:00","endTime":"13:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Planning","status_before_clarification":null}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_history.insert([{"event_id":7,"field":"Start time","old_value":"10:00","new_value":"11:00","changed_by":"ORG-1"},{"event_id":7,"field":"End time","old_value":"12:00","new_value":"13:00","changed_by":"ORG-1"}])",
            "event_outbox.insert({"type":"event.rescheduled","event_id":7,"actor_id":"ORG-1","recipients":{"userIds":[],"roles":[]},"data":{"eventName":"Film Night","coordinatorId":"COORD-1","proposedDate":"2099-06-01","startTime":"11:00","endTime":"13:00"}}).select("id, message_id, type, event_id, actor_id, recipients, data, occurred_at").single()",
            "event_clarifications.select("id").eq("event_id", 7).is("parent_id", null).eq("resolved", false).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
            "event_clarifications.insert({"event_id":7,"parent_id":null,"author_id":"ORG-1","author_role":"organiser","message":"Start time changed from '10:00' to '11:00'\\nEnd time changed from '12:00' to '13:00'"})",
          ],
          "published": [
            {
              "actorId": "ORG-1",
              "data": {
                "coordinatorId": "COORD-1",
                "endTime": "13:00",
                "eventName": "Film Night",
                "proposedDate": "2099-06-01",
                "startTime": "11:00",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [],
              },
              "type": "event.rescheduled",
            },
            {
              "actorId": "ORG-1",
              "data": {
                "eventName": "Film Night",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "COORD-1",
                ],
              },
              "type": "clarification.answered",
            },
          ],
          "status": 200,
        }
      `);
      expect(await patch(details, { reply: clarifying() })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Planning","status_before_clarification":null}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [
            {
              "actorId": "ORG-1",
              "data": {
                "eventName": "Film Night",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "COORD-1",
                ],
              },
              "type": "clarification.answered",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("carries on and logs when the reply cannot be saved", async () => {
      const outcome = await patch(rescheduled, { reply: { ...clarifying(), "event_clarifications.insert": { error: { message: "x" } } } });
      expect(outcome.status).toBe(200);
      expect(console.error).toHaveBeenCalledWith("Failed to record clarification response reply", { eventId: 7, error: { message: "x" } });
    });

    it("does not log when the reply saves", async () => {
      await patch({ ...details, description: "Short films" }, { reply: clarifying() });
      expect(console.error).not.toHaveBeenCalled();
    });

    it("tells nobody when no coordinator is assigned", async () => {
      expect((await patch({ ...details, description: "Short films" }, { reply: clarifying({ coordinator_id: null }) })).published).toEqual([]);
    });

    it("500s when the save fails", async () => {
      expect(await patch(rescheduled, { reply: { ...clarifying(), "events.update": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to save your response",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"11:00","endTime":"13:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Planning","status_before_clarification":null}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// GET /unassigned  (E1-8)
// ---------------------------------------------------------------------------------------------

describe("GET /api/events/unassigned", () => {
  const lead = { id: "LEAD-1", role: "coordinator_lead" };
  const get = (options: Parameters<typeof send>[2] = {}) => send("get", "/api/events/unassigned", { user: lead, ...options });

  it("turns away a caller with no user or no client", async () => {
    expect(await get({ user: null })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Unauthenticated",
        },
        "calls": [],
        "published": [],
        "status": 401,
      }
    `);
    expect(await get({ noClient: true })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Unauthenticated",
        },
        "calls": [],
        "published": [],
        "status": 401,
      }
    `);
  });

  it("is for the Lead only, and records anyone else's attempt", async () => {
    expect(await get({ user: coordinator })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Access denied",
        },
        "calls": [
          "access_denials.insert({"user_id":"COORD-1","event_id":"unassigned_queue","reason":"unassigned_queue_role_not_allowed"})",
        ],
        "published": [],
        "status": 403,
      }
    `);
  });

  it("lists the unassigned requests, oldest first", async () => {
    expect(await get({ reply: { "events.select": { data: [{ id: 3 }, { id: 4 }] } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "events": [
            {
              "id": 3,
            },
            {
              "id": 4,
            },
          ],
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("status", "Unassigned").is("coordinator_id", null).order("created_at", {"ascending":true})",
        ],
        "published": [],
        "status": 200,
      }
    `);
  });

  it("answers an empty list when there is no data", async () => {
    expect((await get()).body).toEqual({ events: [] });
  });

  it("500s when the queue cannot be read", async () => {
    expect(await get({ reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to load the unassigned queue",
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("status", "Unassigned").is("coordinator_id", null).order("created_at", {"ascending":true})",
        ],
        "published": [],
        "status": 500,
      }
    `);
  });
});

// ---------------------------------------------------------------------------------------------
// GET /safety-review-queue  (E1-10, E3-12, E3-14)
// ---------------------------------------------------------------------------------------------

describe("GET /api/events/safety-review-queue", () => {
  const officer = { id: "SO-1", role: "safety_officer" };
  const get = (options: Parameters<typeof send>[2] = {}) =>
    send("get", "/api/events/safety-review-queue", { user: officer, authorization: "Bearer officer-token", ...options });

  const fetched: [string, unknown][] = [];
  const failBookings = new Set<number>();
  const failEquipment = new Set<number>();
  const throwReviews = new Set<number>();
  beforeEach(() => {
    fetched.length = 0;
    failBookings.clear();
    failEquipment.clear();
    throwReviews.clear();
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      fetched.push([url, init.headers.Authorization]);
      const venueId = /events\/(\d+)\/bookings/.exec(url)?.[1];
      if (venueId) {
        if (failBookings.has(Number(venueId))) return { ok: false, json: async () => ({}) };
        return { ok: true, json: async () => ({ bookings: [{ id: Number(venueId) * 10, status: "Approved", venue: { id: 1, name: "Hall" } }] }) };
      }
      const equipmentId = /eventId=(\d+)/.exec(url)?.[1];
      if (failEquipment.has(Number(equipmentId))) return { ok: false, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          equipmentRequests: [
            { id: 1, status: "Open", items: [{ id: Number(equipmentId) * 100, equipmentType: "Projector", quantity: 2, quantityFulfilled: 1 }] },
            { id: 2, status: "Cancelled", items: [{ id: 999, equipmentType: "Mic", quantity: 1, quantityFulfilled: 0 }] },
          ],
        }),
      };
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const eventIdOf = (call: Call): number => Number(call.ops.find(([name]) => name === "eq")?.[1][1]);

  it("turns away a caller with no user or no client", async () => {
    expect(await get({ user: null })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Unauthenticated",
        },
        "calls": [],
        "published": [],
        "status": 401,
      }
    `);
    expect(await get({ noClient: true })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Unauthenticated",
        },
        "calls": [],
        "published": [],
        "status": 401,
      }
    `);
  });

  it("is for the Safety Officer only, and records anyone else's attempt", async () => {
    expect(await get({ user: coordinator })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Access denied",
        },
        "calls": [
          "access_denials.insert({"user_id":"COORD-1","event_id":"safety_review_queue","reason":"safety_review_queue_role_not_allowed"})",
        ],
        "published": [],
        "status": 403,
      }
    `);
  });

  it("500s when the queue or the safety notes cannot be read", async () => {
    expect(await get({ reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to load the safety review queue",
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("status", "Safety Review").order("created_at", {"ascending":true})",
        ],
        "published": [],
        "status": 500,
      }
    `);
    expect(await get({ reply: { "events.select": { data: [{ id: 7 }] }, "event_safety_submissions.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to load safety notes",
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("status", "Safety Review").order("created_at", {"ascending":true})",
          "event_safety_submissions.select("event_id, equipment_placement, crowd_movement, emergency_access, venue_restrictions, submitted_at").in("event_id", [7]).order("submitted_at", {"ascending":false})",
        ],
        "published": [],
        "status": 500,
      }
    `);
  });

  it("asks for a placeholder id when the queue is empty, and answers an empty list", async () => {
    expect(await get({ reply: { "events.select": { data: [] } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "events": [],
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("status", "Safety Review").order("created_at", {"ascending":true})",
          "event_safety_submissions.select("event_id, equipment_placement, crowd_movement, emergency_access, venue_restrictions, submitted_at").in("event_id", [-1]).order("submitted_at", {"ascending":false})",
        ],
        "published": [],
        "status": 200,
      }
    `);
    expect((await get()).body).toEqual({ events: [] });
    expect(fetched).toEqual([]);
  });

  it("copes with no data at all, and with an event row that has no id", async () => {
    expect(await get()).toMatchInlineSnapshot(`
      {
        "body": {
          "events": [],
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("status", "Safety Review").order("created_at", {"ascending":true})",
          "event_safety_submissions.select("event_id, equipment_placement, crowd_movement, emergency_access, venue_restrictions, submitted_at").in("event_id", [-1]).order("submitted_at", {"ascending":false})",
        ],
        "published": [],
        "status": 200,
      }
    `);
    // submissions come back null while the queue holds an id-less row: nothing may be attached to it
    expect((await get({ reply: { "events.select": { data: [{}] } } })).body).toMatchObject({ events: [{ safetyNotes: null }] });
  });

  it("returns each event with its latest safety notes and the arrangements the officer may flag", async () => {
    const submission = (id: number, n: number) => ({
      event_id: id,
      equipment_placement: `placement ${n}`,
      crowd_movement: `crowd ${n}`,
      emergency_access: `access ${n}`,
      venue_restrictions: `restrictions ${n}`,
      submitted_at: `2026-01-0${n}`,
    });
    const outcome = await get({
      reply: {
        "events.select": { data: [{ id: 7 }, { id: 8 }] },
        // newest first: for event 7 the first row is the latest and the older one must be ignored
        "event_safety_submissions.select": { data: [submission(7, 2), submission(8, 3), submission(7, 1)] },
      },
    });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "body": {
          "events": [
            {
              "arrangements": [
                {
                  "detail": "Approved",
                  "id": 70,
                  "label": "Hall",
                  "type": "venue_booking",
                },
                {
                  "detail": "1 of 2 reserved",
                  "id": 700,
                  "label": "Projector × 2",
                  "type": "equipment_item",
                },
              ],
              "changeRequest": null,
              "id": 7,
              "safetyNotes": {
                "crowdMovement": "crowd 2",
                "emergencyAccess": "access 2",
                "equipmentPlacement": "placement 2",
                "venueRestrictions": "restrictions 2",
              },
            },
            {
              "arrangements": [
                {
                  "detail": "Approved",
                  "id": 80,
                  "label": "Hall",
                  "type": "venue_booking",
                },
                {
                  "detail": "1 of 2 reserved",
                  "id": 800,
                  "label": "Projector × 2",
                  "type": "equipment_item",
                },
              ],
              "changeRequest": null,
              "id": 8,
              "safetyNotes": {
                "crowdMovement": "crowd 3",
                "emergencyAccess": "access 3",
                "equipmentPlacement": "placement 3",
                "venueRestrictions": "restrictions 3",
              },
            },
          ],
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("status", "Safety Review").order("created_at", {"ascending":true})",
          "event_safety_submissions.select("event_id, equipment_placement, crowd_movement, emergency_access, venue_restrictions, submitted_at").in("event_id", [7,8]).order("submitted_at", {"ascending":false})",
          "event_safety_reviews.select("id, outcome, reason, general_note, created_at, officer:officer_id(name)").eq("event_id", 7).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
          "event_safety_reviews.select("id, outcome, reason, general_note, created_at, officer:officer_id(name)").eq("event_id", 8).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
        ],
        "published": [],
        "status": 200,
      }
    `);
    expect(fetched).toMatchInlineSnapshot(`
      [
        [
          "http://localhost:4003/api/venues/events/7/bookings",
          "Bearer officer-token",
        ],
        [
          "http://localhost:4005/api/equipment-requests?eventId=7",
          "Bearer officer-token",
        ],
        [
          "http://localhost:4003/api/venues/events/8/bookings",
          "Bearer officer-token",
        ],
        [
          "http://localhost:4005/api/equipment-requests?eventId=8",
          "Bearer officer-token",
        ],
      ]
    `);
  });

  it("shows the open change request with its flags", async () => {
    const outcome = await get({
      reply: {
        "events.select": { data: [{ id: 7 }] },
        "event_safety_reviews.select": {
          data: { id: 40, outcome: "Changes Requested", reason: "Fix", general_note: "Soon", created_at: "2026-01-01", officer: { name: "Sam" } },
        },
        "event_safety_review_flags.select": {
          data: [{ id: 1, arrangement_type: "venue_booking", arrangement_id: 70, label: "Hall", note: "Move it", snapshot: { status: "Approved" }, cleared_at: null }],
        },
      },
    });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "body": {
          "events": [
            {
              "arrangements": [
                {
                  "detail": "Approved",
                  "id": 70,
                  "label": "Hall",
                  "type": "venue_booking",
                },
                {
                  "detail": "1 of 2 reserved",
                  "id": 700,
                  "label": "Projector × 2",
                  "type": "equipment_item",
                },
              ],
              "changeRequest": {
                "arrangementsChecked": true,
                "flags": [
                  {
                    "clearedAt": null,
                    "id": 70,
                    "label": "Hall",
                    "note": "Move it",
                    "type": "venue_booking",
                  },
                ],
                "generalNote": "Soon",
                "officerName": "Sam",
                "reason": "Fix",
                "requestedAt": "2026-01-01",
                "reviewId": 40,
              },
              "id": 7,
              "safetyNotes": null,
            },
          ],
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("status", "Safety Review").order("created_at", {"ascending":true})",
          "event_safety_submissions.select("event_id, equipment_placement, crowd_movement, emergency_access, venue_restrictions, submitted_at").in("event_id", [7]).order("submitted_at", {"ascending":false})",
          "event_safety_reviews.select("id, outcome, reason, general_note, created_at, officer:officer_id(name)").eq("event_id", 7).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
          "event_safety_review_flags.select("id, arrangement_type, arrangement_id, label, note, snapshot, cleared_at").eq("review_id", 40).order("id")",
        ],
        "published": [],
        "status": 200,
      }
    `);
  });

  it("degrades per event: what cannot be read is null, the rest of the queue still loads", async () => {
    failBookings.add(8);
    failEquipment.add(10);
    throwReviews.add(11);
    const outcome = await get({
      reply: {
        "events.select": { data: [{ id: 7 }, { id: 8 }, { id: 9 }, { id: 10 }, { id: 11 }] },
        "event_safety_reviews.select": (call) => {
          const id = eventIdOf(call);
          if (throwReviews.has(id)) throw new Error("boom");
          if (id === 9) return { error: { message: "x" } };
          // 8 and 10 keep an open change request even though one service could not answer
          return { data: { id: 40 + id, outcome: id === 8 || id === 10 ? "Changes Requested" : "Approved", reason: "Fix", created_at: "2026-01-01" } };
        },
        "event_safety_review_flags.select": { data: [] },
      },
    });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "body": {
          "events": [
            {
              "arrangements": [
                {
                  "detail": "Approved",
                  "id": 70,
                  "label": "Hall",
                  "type": "venue_booking",
                },
                {
                  "detail": "1 of 2 reserved",
                  "id": 700,
                  "label": "Projector × 2",
                  "type": "equipment_item",
                },
              ],
              "changeRequest": null,
              "id": 7,
              "safetyNotes": null,
            },
            {
              "arrangements": null,
              "changeRequest": {
                "arrangementsChecked": false,
                "flags": [],
                "generalNote": null,
                "officerName": null,
                "reason": "Fix",
                "requestedAt": "2026-01-01",
                "reviewId": 48,
              },
              "id": 8,
              "safetyNotes": null,
            },
            {
              "arrangements": [
                {
                  "detail": "Approved",
                  "id": 90,
                  "label": "Hall",
                  "type": "venue_booking",
                },
                {
                  "detail": "1 of 2 reserved",
                  "id": 900,
                  "label": "Projector × 2",
                  "type": "equipment_item",
                },
              ],
              "changeRequest": null,
              "id": 9,
              "safetyNotes": null,
            },
            {
              "arrangements": null,
              "changeRequest": {
                "arrangementsChecked": false,
                "flags": [],
                "generalNote": null,
                "officerName": null,
                "reason": "Fix",
                "requestedAt": "2026-01-01",
                "reviewId": 50,
              },
              "id": 10,
              "safetyNotes": null,
            },
            {
              "arrangements": null,
              "changeRequest": null,
              "id": 11,
              "safetyNotes": null,
            },
          ],
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("status", "Safety Review").order("created_at", {"ascending":true})",
          "event_safety_submissions.select("event_id, equipment_placement, crowd_movement, emergency_access, venue_restrictions, submitted_at").in("event_id", [7,8,9,10,11]).order("submitted_at", {"ascending":false})",
          "event_safety_reviews.select("id, outcome, reason, general_note, created_at, officer:officer_id(name)").eq("event_id", 7).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
          "event_safety_reviews.select("id, outcome, reason, general_note, created_at, officer:officer_id(name)").eq("event_id", 8).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
          "event_safety_reviews.select("id, outcome, reason, general_note, created_at, officer:officer_id(name)").eq("event_id", 9).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
          "event_safety_reviews.select("id, outcome, reason, general_note, created_at, officer:officer_id(name)").eq("event_id", 10).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
          "event_safety_reviews.select("id, outcome, reason, general_note, created_at, officer:officer_id(name)").eq("event_id", 11).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
          "event_safety_review_flags.select("id, arrangement_type, arrangement_id, label, note, snapshot, cleared_at").eq("review_id", 48).order("id")",
          "event_safety_review_flags.select("id, arrangement_type, arrangement_id, label, note, snapshot, cleared_at").eq("review_id", 50).order("id")",
        ],
        "published": [],
        "status": 200,
      }
    `);
  });
});

// ---------------------------------------------------------------------------------------------
// GET /:id/change-requests  (E3-8, E3-9, E3-10)
// ---------------------------------------------------------------------------------------------

describe("GET /api/events/:id/change-requests", () => {
  const get = (options: Parameters<typeof send>[2] = {}) =>
    send("get", "/api/events/7/change-requests", { authorization: "Bearer caller-token", ...options });
  const own: Responder = { "events.select": { data: eventRow() } };

  // what the three sibling services answer; null = the service is down
  type Services = { bookings: unknown; equipment: unknown; registrations: unknown; availability: unknown };
  let services: Services;
  const fetched: [string, unknown][] = [];
  const approvedBooking = (overrides: Record<string, unknown> = {}) => ({
    id: 70,
    status: "Approved",
    venue: { id: 1, name: "Hall", capacity: 20 },
    ...overrides,
  });
  beforeEach(() => {
    fetched.length = 0;
    services = {
      bookings: { bookings: [approvedBooking()] },
      equipment: { equipmentRequests: [{ id: 5, status: "Open", items: [{ id: 50, equipmentType: "Projector", quantity: 2, quantityFulfilled: 2 }] }] },
      registrations: {
        registrations: [
          { registrationId: 1, userId: "A-1", status: "Registered", name: "Ann" },
          { registrationId: 2, userId: "A-2", status: "Withdrawn", name: null },
          { registrationId: 3, userId: "A-3", status: "Registered", name: "Cy" },
        ],
      },
      availability: { available: true },
    };
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      fetched.push([url, init.headers.Authorization]);
      const body = url.includes("availability-check")
        ? services.availability
        : url.includes("/api/registrations/")
          ? services.registrations
          : url.includes("equipment-requests")
            ? services.equipment
            : services.bookings;
      return body === null ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => body };
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const field = (request_id: number, name: string, old_value: string | null, new_value: string, is_critical: boolean, applied_at: string | null = null) => ({
    request_id,
    field: name,
    old_value,
    new_value,
    is_critical,
    applied_at,
  });
  const listing = (requests: unknown[], fields: unknown[]): Responder => ({
    ...own,
    "change_requests.select": { data: requests },
    "change_request_fields.select": { data: fields },
  });
  const request = (id: number, status: string, extra: Record<string, unknown> = {}) => ({
    id,
    status,
    decided_at: null,
    decision_reason: null,
    created_at: `2026-01-0${id % 10}`,
    ...extra,
  });

  it("turns away a caller with no user or no client", async () => {
    expect(await get({ user: null })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Unauthenticated",
        },
        "calls": [],
        "published": [],
        "status": 401,
      }
    `);
    expect(await get({ noClient: true })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Unauthenticated",
        },
        "calls": [],
        "published": [],
        "status": 401,
      }
    `);
  });

  it("404s a malformed or unknown event and 500s a failed lookup", async () => {
    expect(await send("get", "/api/events/abc/change-requests")).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Event not found",
        },
        "calls": [],
        "published": [],
        "status": 404,
      }
    `);
    expect(await get({ reply: {} })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Event not found",
        },
        "calls": [
          "events.select("id, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
        ],
        "published": [],
        "status": 404,
      }
    `);
    expect(await get({ reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to load event",
        },
        "calls": [
          "events.select("id, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
        ],
        "published": [],
        "status": 500,
      }
    `);
  });

  it("is for the owner or the assigned coordinator only, and records anyone else's attempt", async () => {
    expect(await get({ user: { id: "ORG-2", role: "organiser" }, reply: own })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Access denied",
        },
        "calls": [
          "events.select("id, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "access_denials.insert({"user_id":"ORG-2","event_id":"7","reason":"not_found_or_not_owner"})",
        ],
        "published": [],
        "status": 403,
      }
    `);
    // the coordinator's id with another role is not the assigned coordinator
    expect((await get({ user: { id: "COORD-1", role: "attendee" }, reply: own })).status).toBe(403);
    expect((await get({ user: { id: "COORD-2", role: "coordinator" }, reply: own })).status).toBe(403);
    expect((await get({ user: coordinator, reply: own })).status).toBe(200);
    expect((await get({ user: organiser, reply: own })).status).toBe(200);
  });

  it("500s when the requests or their fields cannot be read", async () => {
    expect(await get({ reply: { ...own, "change_requests.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to load change requests",
        },
        "calls": [
          "events.select("id, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id, status, decided_at, decision_reason, created_at").eq("event_id", 7).order("created_at", {"ascending":false})",
        ],
        "published": [],
        "status": 500,
      }
    `);
    expect(await get({ reply: { ...own, "change_requests.select": { data: [request(11, "Approved")] }, "change_request_fields.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to load change requests",
        },
        "calls": [
          "events.select("id, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id, status, decided_at, decision_reason, created_at").eq("event_id", 7).order("created_at", {"ascending":false})",
          "change_request_fields.select("request_id, field, old_value, new_value, is_critical, applied_at").in("request_id", [11])",
        ],
        "published": [],
        "status": 500,
      }
    `);
  });

  it("answers an empty list when there are no requests, and fetches nothing", async () => {
    expect(await get({ reply: own })).toMatchInlineSnapshot(`
      {
        "body": {
          "changeRequests": [],
        },
        "calls": [
          "events.select("id, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id, status, decided_at, decision_reason, created_at").eq("event_id", 7).order("created_at", {"ascending":false})",
          "change_request_fields.select("request_id, field, old_value, new_value, is_critical, applied_at").in("request_id", [-1])",
        ],
        "published": [],
        "status": 200,
      }
    `);
    expect(fetched).toEqual([]);
  });

  it("lists every request newest first with each field's outcome", async () => {
    const outcome = await get({
      reply: listing(
        [
          request(14, "Auto-Withdrawn", { decided_at: "2026-01-05", decision_reason: "Reverted" }),
          request(13, "Rejected", { decided_at: "2026-01-04", decision_reason: "No" }),
          request(12, "Approved", { decided_at: "2026-01-03" }),
        ],
        [
          field(14, "venue", "Hall", "Park", true),
          field(14, "description", "a", "b", false),
          field(13, "venue", "Hall", "Park", true),
          field(13, "name", "A", "B", false),
          field(12, "venue", "Hall", "Park", true, "2026-01-03"),
          field(12, "equipment", "x", "y", true),
        ],
      ),
    });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "body": {
          "changeRequests": [
            {
              "createdAt": "2026-01-04",
              "decidedAt": "2026-01-05",
              "decisionReason": "Reverted",
              "fields": [
                {
                  "field": "venue",
                  "isCritical": true,
                  "newValue": "Park",
                  "oldValue": "Hall",
                  "outcome": "withdrawn",
                },
                {
                  "field": "description",
                  "isCritical": false,
                  "newValue": "b",
                  "oldValue": "a",
                  "outcome": "applied",
                },
              ],
              "id": 14,
              "impact": null,
              "status": "Auto-Withdrawn",
            },
            {
              "createdAt": "2026-01-03",
              "decidedAt": "2026-01-04",
              "decisionReason": "No",
              "fields": [
                {
                  "field": "venue",
                  "isCritical": true,
                  "newValue": "Park",
                  "oldValue": "Hall",
                  "outcome": "rejected",
                },
                {
                  "field": "name",
                  "isCritical": false,
                  "newValue": "B",
                  "oldValue": "A",
                  "outcome": "applied",
                },
              ],
              "id": 13,
              "impact": null,
              "status": "Rejected",
            },
            {
              "createdAt": "2026-01-02",
              "decidedAt": "2026-01-03",
              "decisionReason": null,
              "fields": [
                {
                  "field": "venue",
                  "isCritical": true,
                  "newValue": "Park",
                  "oldValue": "Hall",
                  "outcome": "applied",
                },
                {
                  "field": "equipment",
                  "isCritical": true,
                  "newValue": "y",
                  "oldValue": "x",
                  "outcome": "pending",
                },
              ],
              "id": 12,
              "impact": null,
              "status": "Approved",
            },
          ],
        },
        "calls": [
          "events.select("id, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id, status, decided_at, decision_reason, created_at").eq("event_id", 7).order("created_at", {"ascending":false})",
          "change_request_fields.select("request_id, field, old_value, new_value, is_critical, applied_at").in("request_id", [14,13,12])",
        ],
        "published": [],
        "status": 200,
      }
    `);
    expect(fetched).toEqual([]);
  });

  it("assesses the impact of each Pending request from its still-open fields", async () => {
    services.availability = {
      available: false,
      unavailabilityConflict: { reason: "Maintenance", description: "Floor" },
      bookingConflict: { bookingId: 71, status: "Approved", window: "11:00-13:00" },
    };
    services.bookings = {
      bookings: [
        { id: 69, status: "Withdrawn", venue: { id: 2, name: "Old", capacity: 5 } },
        approvedBooking(),
        approvedBooking({ id: 72, venue: { id: 3, name: "Tiny", capacity: 10 } }),
      ],
    };
    const outcome = await get({
      reply: listing(
        [request(11, "Pending")],
        [
          field(11, "expectedAttendance", "30", "25", true),
          field(11, "startTime", "10:00", "11:00", true),
          // already applied in an earlier partial decision: must not count as requested
          field(11, "proposedDate", "2099-06-01", "2099-07-01", true, "2026-01-02"),
        ],
      ),
    });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "body": {
          "changeRequests": [
            {
              "createdAt": "2026-01-01",
              "decidedAt": null,
              "decisionReason": null,
              "fields": [
                {
                  "field": "expectedAttendance",
                  "isCritical": true,
                  "newValue": "25",
                  "oldValue": "30",
                  "outcome": "pending",
                },
                {
                  "field": "startTime",
                  "isCritical": true,
                  "newValue": "11:00",
                  "oldValue": "10:00",
                  "outcome": "pending",
                },
                {
                  "field": "proposedDate",
                  "isCritical": true,
                  "newValue": "2099-07-01",
                  "oldValue": "2099-06-01",
                  "outcome": "applied",
                },
              ],
              "id": 11,
              "impact": {
                "availabilityConflict": {
                  "bookingConflict": {
                    "bookingId": 71,
                    "status": "Approved",
                    "window": "11:00-13:00",
                  },
                  "bookingId": 70,
                  "unavailabilityConflict": {
                    "description": "Floor",
                    "reason": "Maintenance",
                  },
                },
                "bookings": [
                  {
                    "id": 69,
                    "status": "Withdrawn",
                    "venue": {
                      "id": 2,
                      "name": "Old",
                    },
                  },
                  {
                    "id": 70,
                    "status": "Approved",
                    "venue": {
                      "id": 1,
                      "name": "Hall",
                    },
                  },
                  {
                    "id": 72,
                    "status": "Approved",
                    "venue": {
                      "id": 3,
                      "name": "Tiny",
                    },
                  },
                ],
                "capacityConflict": {
                  "bookingId": 70,
                  "capacity": 20,
                  "requestedAttendance": 25,
                  "venueName": "Hall",
                },
                "equipmentReservations": [
                  {
                    "id": 5,
                    "items": [
                      {
                        "equipmentType": "Projector",
                        "id": 50,
                        "quantity": 2,
                        "quantityFulfilled": 2,
                      },
                    ],
                    "status": "Open",
                  },
                ],
                "registrations": {
                  "registeredCount": 2,
                  "registrations": [
                    {
                      "name": "Ann",
                      "registrationId": 1,
                      "status": "Registered",
                      "userId": "A-1",
                    },
                    {
                      "name": null,
                      "registrationId": 2,
                      "status": "Withdrawn",
                      "userId": "A-2",
                    },
                    {
                      "name": "Cy",
                      "registrationId": 3,
                      "status": "Registered",
                      "userId": "A-3",
                    },
                  ],
                  "total": 3,
                },
              },
              "status": "Pending",
            },
          ],
        },
        "calls": [
          "events.select("id, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id, status, decided_at, decision_reason, created_at").eq("event_id", 7).order("created_at", {"ascending":false})",
          "change_request_fields.select("request_id, field, old_value, new_value, is_critical, applied_at").in("request_id", [11])",
        ],
        "published": [],
        "status": 200,
      }
    `);
    expect(fetched).toMatchInlineSnapshot(`
      [
        [
          "http://localhost:4003/api/venues/events/7/bookings",
          "Bearer caller-token",
        ],
        [
          "http://localhost:4005/api/equipment-requests?eventId=7",
          "Bearer caller-token",
        ],
        [
          "http://localhost:4007/api/registrations/event/7",
          "Bearer caller-token",
        ],
        [
          "http://localhost:4003/api/venues/bookings/70/availability-check?proposedDate=2099-06-01&startTime=11%3A00&endTime=12%3A00",
          "Bearer caller-token",
        ],
      ]
    `);
  });

  it("flags no conflict at exactly the venue's capacity, or when the venue has no capacity", async () => {
    services.bookings = {
      bookings: [
        approvedBooking({ id: 73, venue: null }),
        approvedBooking({ venue: { id: 1, name: "Hall", capacity: 25 } }),
        approvedBooking({ id: 71, venue: { id: 2, name: "Open" } }),
      ],
    };
    // only the attendance field is read as the attendance, whatever else is held or comes first
    const outcome = await get({
      reply: listing([request(11, "Pending")], [field(11, "description", "a", "50", false), field(11, "expectedAttendance", "30", "25", true)]),
    });
    expect(outcome.status).toBe(200);
    expect((outcome.body as any).changeRequests[0].impact.capacityConflict).toBeNull();
    // an attendance change alone is not a schedule change
    expect(fetched.some(([url]) => String(url).includes("availability"))).toBe(false);
    // an attendance that is not a number asks for no capacity check
    const garbled = await get({ reply: listing([request(11, "Pending")], [field(11, "expectedAttendance", "30", "lots", true)]) });
    expect((garbled.body as any).changeRequests[0].impact.capacityConflict).toBeNull();
  });

  it("checks the schedule against the first booked venue, filling the gaps from the committed event", async () => {
    await get({ reply: listing([request(11, "Pending")], [field(11, "endTime", "12:00", "14:00", true)]) });
    expect(fetched.map(([url]) => url).filter((url) => url.includes("availability"))).toEqual([
      "http://localhost:4003/api/venues/bookings/70/availability-check?proposedDate=2099-06-01&startTime=10%3A00&endTime=14%3A00",
    ]);
    fetched.length = 0;
    // a new date alone is a schedule change, and its time is the committed one
    await get({ reply: listing([request(11, "Pending")], [field(11, "proposedDate", "2099-06-01", "2099-07-01", true)]) });
    expect(fetched.map(([url]) => url).filter((url) => url.includes("availability"))).toEqual([
      "http://localhost:4003/api/venues/bookings/70/availability-check?proposedDate=2099-07-01&startTime=10%3A00&endTime=12%3A00",
    ]);
    fetched.length = 0;
    // no booked venue: nothing to check
    services.bookings = { bookings: [{ id: 70, status: "Approved", venue: null }] };
    await get({ reply: listing([request(11, "Pending")], [field(11, "endTime", "12:00", "14:00", true)]) });
    expect(fetched.some(([url]) => String(url).includes("availability"))).toBe(false);
  });

  it("reports no availability conflict when the venue is free or cannot be asked", async () => {
    const free = await get({ reply: listing([request(11, "Pending")], [field(11, "startTime", "10:00", "11:00", true)]) });
    expect((free.body as any).changeRequests[0].impact.availabilityConflict).toBeNull();
    services.availability = null;
    const down = await get({ reply: listing([request(11, "Pending")], [field(11, "startTime", "10:00", "11:00", true)]) });
    expect(down.status).toBe(200);
    expect((down.body as any).changeRequests[0].impact.availabilityConflict).toBeNull();
  });

  it("gives no impact when any of the three services cannot answer", async () => {
    for (const service of ["bookings", "equipment", "registrations"] as const) {
      const saved = services[service];
      services[service] = null;
      const outcome = await get({ reply: listing([request(11, "Pending")], []) });
      expect([service, (outcome.body as any).changeRequests[0].impact]).toEqual([service, null]);
      services[service] = saved;
    }
  });

  it("gives no impact to a request that is not Pending", async () => {
    const outcome = await get({ reply: listing([request(12, "Approved")], []) });
    expect((outcome.body as any).changeRequests[0].impact).toBeNull();
    expect((outcome.body as any).changeRequests[0].fields).toEqual([]);
    expect(fetched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /:id/change-requests/:requestId/approve | reject  (E3-11)
// ---------------------------------------------------------------------------------------------

describe("deciding a change request", () => {
  const approve = (body: unknown = {}, options: Parameters<typeof send>[2] = {}) =>
    send("post", "/api/events/7/change-requests/11/approve", { user: coordinator, body, authorization: "Bearer coord-token", ...options });
  const reject = (body: unknown = { reason: "Too late" }, options: Parameters<typeof send>[2] = {}) =>
    send("post", "/api/events/7/change-requests/11/reject", { user: coordinator, body, authorization: "Bearer coord-token", ...options });

  // what the sibling services answer; null = the service is down
  type Services = { bookings: unknown; equipment: unknown; registrations: unknown; availability: unknown; flagBooking: unknown; flagEquipment: unknown };
  let services: Services;
  const fetched: unknown[][] = [];
  const venue = (id: number, capacity: number) => ({ id, status: "Approved", venue: { id: 1, name: `Hall ${id}`, capacity } });
  beforeEach(() => {
    fetched.length = 0;
    services = {
      bookings: { bookings: [venue(70, 100)] },
      equipment: { equipmentRequests: [] },
      registrations: { registrations: [] },
      availability: { available: true },
      flagBooking: { staffNotified: true },
      flagEquipment: { flaggedRequestIds: [5], notified: true },
    };
    vi.stubGlobal("fetch", async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
      fetched.push(init.method === "POST" ? [url, init.headers.Authorization, init.body] : [url, init.headers.Authorization]);
      const body = url.includes("flag-for-rebooking")
        ? services.flagBooking
        : url.includes("flag-for-event")
          ? services.flagEquipment
          : url.includes("availability-check")
            ? services.availability
            : url.includes("/api/registrations/")
              ? services.registrations
              : url.includes("equipment-requests")
                ? services.equipment
                : services.bookings;
      return body === null ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => body };
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const held = (name: string, oldValue: string | null, newValue: string, critical = true) => ({ field: name, old_value: oldValue, new_value: newValue, is_critical: critical });
  const stateRow = (overrides: Record<string, unknown> = {}) => eventRow({ status: "Needs Review", safety_approval_stale: false, ...overrides });
  /** events.update echoes what was written, so the stored value matches the approved one. */
  const echo = (call: Call): Reply => ({ data: { id: 7, organiser_id: "ORG-1", submitted_details: (call.ops[0][1][0] as any).submitted_details } });
  const pending = (fields: unknown[], overrides: Responder = {}, event: Record<string, unknown> = {}): Responder => ({
    "events.select": { data: stateRow(event) },
    "change_requests.select": { data: { id: 11, status: "Pending" } },
    "change_request_fields.select": { data: fields },
    "events.update": echo,
    ...overrides,
  });

  describe("loading the event and the request (shared by approve and reject)", () => {
    it("turns away a caller with no user or no client", async () => {
      expect(await approve({}, { user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect(await reject({}, { noClient: true })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
    });

    it("404s a malformed or unknown event and 500s a failed lookup", async () => {
      expect(await send("post", "/api/events/abc/change-requests/11/approve", { user: coordinator })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [],
          "published": [],
          "status": 404,
        }
      `);
      expect(await approve({}, { reply: {} })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 404,
        }
      `);
      expect(await reject({}, { reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load event",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("is for the event's assigned coordinator only", async () => {
      const reply = pending([held("venue", "Hall", "Park")]);
      expect(await approve({}, { user: { id: "COORD-2", role: "coordinator" }, reply })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Only the event's assigned coordinator can decide this change request",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 403,
        }
      `);
      // the assigned coordinator's id is not enough without the role
      expect((await reject({}, { user: { id: "COORD-1", role: "organiser" }, reply })).status).toBe(403);
      expect((await reject({}, { user: { id: "COORD-2", role: "coordinator" }, reply })).status).toBe(403);
    });

    it("404s a malformed or unknown request, 500s failed reads, and 409s one already decided", async () => {
      expect(await send("post", "/api/events/7/change-requests/abc/approve", { user: coordinator, reply: pending([]) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Change request not found",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 404,
        }
      `);
      expect(await approve({}, { reply: pending([], { "change_requests.select": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Change request not found",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 404,
        }
      `);
      expect(await approve({}, { reply: pending([], { "change_requests.select": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load the change request",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await reject({}, { reply: pending([], { "change_requests.select": { data: { id: 11, status: "Approved" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This change request has already been decided.",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
      expect(await reject({}, { reply: pending([], { "change_request_fields.select": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load the change request",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("approve", () => {
    it("refuses an event that is closed or has not entered the process", async () => {
      for (const status of ["Draft", "Unassigned", "Rejected", "Completed", "Cancelled"]) {
        const outcome = await approve({}, { reply: pending([held("venue", "Hall", "Park")], {}, { status }) });
        expect([status, outcome.status, outcome.calls.length, outcome.body]).toEqual([
          status,
          409,
          1,
          { error: `A change request can't be approved while the event is ${status}.` },
        ]);
      }
    });

    it("approves by default every held field and nothing else", async () => {
      const outcome = await approve({}, { reply: pending([held("expectedAttendance", "30", "25"), held("description", "a", "b", false)]) });
      expect(outcome).toMatchInlineSnapshot(`
        {
          "body": {
            "approvedFields": [
              "expectedAttendance",
            ],
            "bookingsFlagged": [],
            "equipmentFlagged": false,
            "event": {
              "id": 7,
              "organiser_id": "ORG-1",
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 25,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
            "notificationsFailed": false,
            "remainingFields": [],
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":25,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Needs Review","safety_approval_stale":true}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").single()",
            "change_request_fields.update({"applied_at":"2026-01-01T00:00:00.000Z"}).eq("request_id", 11).in("field", ["expectedAttendance"])",
            "change_requests.update({"status":"Approved","decided_by":"COORD-1","decided_at":"2026-01-01T00:00:00.000Z"}).eq("id", 11)",
            "event_history.insert([{"event_id":7,"field":"expectedAttendance","old_value":"30","new_value":"25","changed_by":"COORD-1"}])",
            "event_outbox.insert({"type":"event.attendance_changed","event_id":7,"actor_id":"COORD-1","recipients":{"userIds":[],"roles":[]},"data":{"eventName":"Film Night","coordinatorId":"COORD-1","expectedAttendance":25}}).select("id, message_id, type, event_id, actor_id, recipients, data, occurred_at").single()",
          ],
          "published": [
            {
              "actorId": "COORD-1",
              "data": {
                "coordinatorId": "COORD-1",
                "eventName": "Film Night",
                "expectedAttendance": 25,
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [],
              },
              "type": "event.attendance_changed",
            },
            {
              "actorId": "COORD-1",
              "data": {
                "eventName": "Film Night",
                "outcome": "approved",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "ORG-1",
                ],
              },
              "type": "change.decided",
            },
          ],
          "status": 200,
        }
      `);
      expect(fetched).toMatchInlineSnapshot(`
        [
          [
            "http://localhost:4003/api/venues/events/7/bookings",
            "Bearer coord-token",
          ],
          [
            "http://localhost:4005/api/equipment-requests?eventId=7",
            "Bearer coord-token",
          ],
          [
            "http://localhost:4007/api/registrations/event/7",
            "Bearer coord-token",
          ],
        ]
      `);
    });

    it("approves just the chosen fields and leaves the rest held", async () => {
      const fields = [held("startTime", "10:00", "11:00"), held("equipment", "Projector", "Mic")];
      expect(await approve({ fields: ["startTime", "startTime", 5, null] }, { reply: pending(fields) })).toMatchInlineSnapshot(`
        {
          "body": {
            "approvedFields": [
              "startTime",
            ],
            "bookingsFlagged": [],
            "equipmentFlagged": false,
            "event": {
              "id": 7,
              "organiser_id": "ORG-1",
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "11:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
            "notificationsFailed": false,
            "remainingFields": [
              "equipment",
            ],
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"11:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Needs Review","safety_approval_stale":true}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").single()",
            "change_request_fields.update({"applied_at":"2026-01-01T00:00:00.000Z"}).eq("request_id", 11).in("field", ["startTime"])",
            "event_history.insert([{"event_id":7,"field":"startTime","old_value":"10:00","new_value":"11:00","changed_by":"COORD-1"}])",
            "event_outbox.insert({"type":"event.rescheduled","event_id":7,"actor_id":"COORD-1","recipients":{"userIds":[],"roles":[]},"data":{"eventName":"Film Night","coordinatorId":"COORD-1","proposedDate":"2099-06-01","startTime":"11:00","endTime":"12:00"}}).select("id, message_id, type, event_id, actor_id, recipients, data, occurred_at").single()",
          ],
          "published": [
            {
              "actorId": "COORD-1",
              "data": {
                "coordinatorId": "COORD-1",
                "endTime": "12:00",
                "eventName": "Film Night",
                "proposedDate": "2099-06-01",
                "startTime": "11:00",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [],
              },
              "type": "event.rescheduled",
            },
            {
              "actorId": "COORD-1",
              "data": {
                "approvedFields": [
                  "startTime",
                ],
                "eventName": "Film Night",
                "outcome": "partially_approved",
                "remainingFields": [
                  "equipment",
                ],
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "ORG-1",
                ],
              },
              "type": "change.decided",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("refuses fields that are not held, and an empty choice", async () => {
      const fields = [held("startTime", "10:00", "11:00"), held("description", "a", "b", false)];
      expect(await approve({ fields: ["startTime", "venue", "venue", "description"] }, { reply: pending(fields) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "These fields aren't held on this request: venue, description",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
          ],
          "published": [],
          "status": 400,
        }
      `);
      expect(await approve({ fields: [] }, { reply: pending(fields) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Approve at least one field, or use reject to decline the whole request.",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
          ],
          "published": [],
          "status": 400,
        }
      `);
      // nothing critical is held at all
      expect(await approve({}, { reply: pending([held("description", "a", "b", false)]) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Approve at least one field, or use reject to decline the whole request.",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
          ],
          "published": [],
          "status": 400,
        }
      `);
      // a body that is not an object, or whose fields are not a list, means "everything"
      expect((await approve({ fields: "startTime" }, { reply: pending(fields) })).status).toBe(200);
      expect((await approve(undefined, { reply: pending(fields) })).status).toBe(200);
    });

    it("moves a Confirmed or Needs Review event to Needs Review and any other to Planning", async () => {
      for (const [from, to] of [["Confirmed", "Needs Review"], ["Needs Review", "Needs Review"], ["Planning", "Planning"], ["Safety Review", "Planning"], ["Requested", "Planning"]]) {
        const outcome = await approve({}, { reply: pending([held("venue", "Hall", "Park")], {}, { status: from }) });
        const update = outcome.calls.find((call) => call.startsWith("events.update"))!;
        expect([from, JSON.parse(update.slice(14, update.indexOf("}).eq") + 1)).status, outcome.status]).toEqual([from, to, 200]);
      }
    });

    it("flags the bookings the approval invalidated, once each, and tells the venue staff", async () => {
      services.bookings = { bookings: [venue(69, 100), venue(70, 20)] };
      services.availability = { available: false, unavailabilityConflict: null, bookingConflict: { bookingId: 80, status: "Approved", window: "x" } };
      const outcome = await approve({}, { reply: pending([held("expectedAttendance", "30", "25"), held("startTime", "10:00", "11:00")]) });
      expect(outcome).toMatchInlineSnapshot(`
        {
          "body": {
            "approvedFields": [
              "expectedAttendance",
              "startTime",
            ],
            "bookingsFlagged": [
              {
                "bookingId": 70,
                "staffNotified": true,
              },
              {
                "bookingId": 69,
                "staffNotified": true,
              },
            ],
            "equipmentFlagged": false,
            "event": {
              "id": 7,
              "organiser_id": "ORG-1",
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 25,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "11:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
            "notificationsFailed": false,
            "remainingFields": [],
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"11:00","endTime":"12:00","expectedAttendance":25,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Needs Review","safety_approval_stale":true}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").single()",
            "change_request_fields.update({"applied_at":"2026-01-01T00:00:00.000Z"}).eq("request_id", 11).in("field", ["expectedAttendance","startTime"])",
            "change_requests.update({"status":"Approved","decided_by":"COORD-1","decided_at":"2026-01-01T00:00:00.000Z"}).eq("id", 11)",
            "event_history.insert([{"event_id":7,"field":"expectedAttendance","old_value":"30","new_value":"25","changed_by":"COORD-1"},{"event_id":7,"field":"startTime","old_value":"10:00","new_value":"11:00","changed_by":"COORD-1"}])",
            "event_outbox.insert({"type":"event.rescheduled","event_id":7,"actor_id":"COORD-1","recipients":{"userIds":[],"roles":[]},"data":{"eventName":"Film Night","coordinatorId":"COORD-1","proposedDate":"2099-06-01","startTime":"11:00","endTime":"12:00"}}).select("id, message_id, type, event_id, actor_id, recipients, data, occurred_at").single()",
            "event_outbox.insert({"type":"event.attendance_changed","event_id":7,"actor_id":"COORD-1","recipients":{"userIds":[],"roles":[]},"data":{"eventName":"Film Night","coordinatorId":"COORD-1","expectedAttendance":25}}).select("id, message_id, type, event_id, actor_id, recipients, data, occurred_at").single()",
          ],
          "published": [
            {
              "actorId": "COORD-1",
              "data": {
                "coordinatorId": "COORD-1",
                "endTime": "12:00",
                "eventName": "Film Night",
                "proposedDate": "2099-06-01",
                "startTime": "11:00",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [],
              },
              "type": "event.rescheduled",
            },
            {
              "actorId": "COORD-1",
              "data": {
                "coordinatorId": "COORD-1",
                "eventName": "Film Night",
                "expectedAttendance": 25,
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [],
              },
              "type": "event.attendance_changed",
            },
            {
              "actorId": "COORD-1",
              "data": {
                "eventName": "Film Night",
                "outcome": "approved",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "ORG-1",
                ],
              },
              "type": "change.decided",
            },
          ],
          "status": 200,
        }
      `);
      expect(fetched).toMatchInlineSnapshot(`
        [
          [
            "http://localhost:4003/api/venues/events/7/bookings",
            "Bearer coord-token",
          ],
          [
            "http://localhost:4005/api/equipment-requests?eventId=7",
            "Bearer coord-token",
          ],
          [
            "http://localhost:4007/api/registrations/event/7",
            "Bearer coord-token",
          ],
          [
            "http://localhost:4003/api/venues/bookings/69/availability-check?proposedDate=2099-06-01&startTime=11%3A00&endTime=12%3A00",
            "Bearer coord-token",
          ],
          [
            "http://localhost:4003/api/venues/bookings/70/flag-for-rebooking",
            "Bearer coord-token",
            "{"reason":"An approved change to expectedAttendance, startTime invalidated this booking."}",
          ],
          [
            "http://localhost:4003/api/venues/bookings/69/flag-for-rebooking",
            "Bearer coord-token",
            "{"reason":"An approved change to expectedAttendance, startTime invalidated this booking."}",
          ],
        ]
      `);
    });

    it("flags one booking once when the same booking fails both checks, and skips a failed flag", async () => {
      services.bookings = { bookings: [venue(70, 20)] };
      services.availability = { available: false, unavailabilityConflict: null, bookingConflict: null };
      const both = await approve({}, { reply: pending([held("expectedAttendance", "30", "25"), held("startTime", "10:00", "11:00")]) });
      expect((both.body as any).bookingsFlagged).toEqual([{ bookingId: 70, staffNotified: true }]);
      expect(fetched.filter(([url]) => String(url).includes("flag-for-rebooking"))).toHaveLength(1);
      services.flagBooking = null;
      const failed = await approve({}, { reply: pending([held("expectedAttendance", "30", "25")]) });
      expect((failed.body as any).bookingsFlagged).toEqual([]);
    });

    it("flags the equipment only when equipment is among the approved fields, and reports whether anything was flagged", async () => {
      const fields = [held("equipment", "Projector", "Mic"), held("venue", "Hall", "Park")];
      const flagged = await approve({}, { reply: pending(fields) });
      expect((flagged.body as any).equipmentFlagged).toBe(true);
      expect(fetched.filter(([url]) => String(url).includes("flag-for-event"))).toMatchInlineSnapshot(`
        [
          [
            "http://localhost:4005/api/equipment-requests/flag-for-event/7",
            "Bearer coord-token",
            "{"reason":"An approved change to equipment requirements may affect the existing reservation."}",
          ],
        ]
      `);
      services.flagEquipment = { flaggedRequestIds: [], notified: false };
      expect(((await approve({}, { reply: pending(fields) })).body as any).equipmentFlagged).toBe(false);
      services.flagEquipment = null;
      expect(((await approve({}, { reply: pending(fields) })).body as any).equipmentFlagged).toBe(false);
      fetched.length = 0;
      await approve({}, { reply: pending([held("venue", "Hall", "Park")]) });
      expect(fetched.some(([url]) => String(url).includes("flag-for-event"))).toBe(false);
    });

    it("announces a new schedule or attendance only when one of them was approved", async () => {
      const mixed = await approve({}, { reply: pending([held("startTime", "10:00", "11:00"), held("venue", "Hall", "Park")]) });
      expect(mixed.published.map((m: any) => m.type)).toEqual(["event.rescheduled", "change.decided"]);
      const attendance = await approve({}, { reply: pending([held("expectedAttendance", "30", "25"), held("venue", "Hall", "Park")]) });
      expect(attendance.published.map((m: any) => m.type)).toEqual(["event.attendance_changed", "change.decided"]);
      const neither = await approve({}, { reply: pending([held("venue", "Hall", "Park")]) });
      expect(neither.published.map((m: any) => m.type)).toEqual(["change.decided"]);
    });

    it("does not flag or fail when the other services cannot be asked", async () => {
      services.bookings = null;
      const outcome = await approve({}, { reply: pending([held("expectedAttendance", "30", "25")]) });
      expect(outcome.status).toBe(200);
      expect((outcome.body as any).bookingsFlagged).toEqual([]);
    });

    it("tells the organiser, or nobody when the event has no organiser, and reports a failed notification", async () => {
      const fields = [held("venue", "Hall", "Park")];
      const told = await approve({}, { reply: pending(fields) });
      expect(told.published).toMatchInlineSnapshot(`
        [
          {
            "actorId": "COORD-1",
            "data": {
              "eventName": "Film Night",
              "outcome": "approved",
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "ORG-1",
              ],
            },
            "type": "change.decided",
          },
        ]
      `);
      expect((told.body as any).notificationsFailed).toBe(false);
      const nobody = await approve({}, { reply: pending(fields, { "events.update": (call) => ({ data: { id: 7, submitted_details: (call.ops[0][1][0] as any).submitted_details } }) }) });
      expect((nobody.published[0] as any).recipients).toEqual({ userIds: [], roles: [] });
      const failed = await approve({}, { reply: pending(fields), publishOk: false });
      expect(failed.status).toBe(200);
      expect((failed.body as any).notificationsFailed).toBe(true);
    });

    it("500s when the event cannot be updated, writing nothing else", async () => {
      expect(await approve({}, { reply: pending([held("venue", "Hall", "Park")], { "events.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to apply the change request",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Park","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Needs Review","safety_approval_stale":true}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("undoes the event write when the stored value is not the approved one", async () => {
      const keepOld = pending([held("startTime", "10:00", "11:00"), held("expectedAttendance", "30", "25"), held("venue", "Hall", "Park")], {
        "events.update": () => ({ data: { id: 7, organiser_id: "ORG-1", submitted_details: { ...details, venue: "Park" } } }),
      });
      expect(await approve({}, { reply: keepOld })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Couldn't apply the change to startTime, expectedAttendance. Nothing was changed; please try again.",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"11:00","endTime":"12:00","expectedAttendance":25,"venue":"Park","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Needs Review","safety_approval_stale":true}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").single()",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Needs Review","safety_approval_stale":false}).eq("id", 7)",
            "change_request_fields.update({"applied_at":null}).eq("request_id", 11).in("field", ["startTime","expectedAttendance","venue"])",
          ],
          "published": [],
          "status": 500,
        }
      `);
      // a Confirmed event whose approval was already stale goes back exactly as it was
      const stale = pending([held("venue", "Hall", "Park")], { "events.update": () => ({ data: { id: 7, submitted_details: details } }) }, { status: "Confirmed", safety_approval_stale: true });
      const outcome = await approve({}, { reply: stale });
      expect(outcome.calls.filter((call) => call.startsWith("events.update")).pop()).toContain('"status":"Confirmed","safety_approval_stale":true');
    });

    it("counts a missing stored value as an empty approved one, and a null approved value as empty", async () => {
      const without = (name: string) => (call: Call): Reply => {
        const { [name]: _dropped, ...rest } = (call.ops[0][1][0] as any).submitted_details;
        return { data: { id: 7, organiser_id: "ORG-1", submitted_details: rest } };
      };
      const emptied = await approve({}, { reply: pending([held("accessibility", "Ramp", "")], { "events.update": without("accessibility") }) });
      expect(emptied.status).toBe(200);
      const cleared = await approve({}, { reply: pending([{ field: "accessibility", old_value: "Ramp", new_value: null, is_critical: true }], { "events.update": without("accessibility") }) });
      expect(cleared.status).toBe(200);
    });

    it("undoes the event write when recording the decision fails", async () => {
      const fields = [held("venue", "Hall", "Park")];
      expect(await approve({}, { reply: pending(fields, { "change_request_fields.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to record the decision",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Park","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Needs Review","safety_approval_stale":true}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").single()",
            "change_request_fields.update({"applied_at":"2026-01-01T00:00:00.000Z"}).eq("request_id", 11).in("field", ["venue"])",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Needs Review","safety_approval_stale":false}).eq("id", 7)",
            "change_request_fields.update({"applied_at":null}).eq("request_id", 11).in("field", ["venue"])",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await approve({}, { reply: pending(fields, { "change_requests.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to record the decision",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Park","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Needs Review","safety_approval_stale":true}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").single()",
            "change_request_fields.update({"applied_at":"2026-01-01T00:00:00.000Z"}).eq("request_id", 11).in("field", ["venue"])",
            "change_requests.update({"status":"Approved","decided_by":"COORD-1","decided_at":"2026-01-01T00:00:00.000Z"}).eq("id", 11)",
            "events.update({"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true},"status":"Needs Review","safety_approval_stale":false}).eq("id", 7)",
            "change_request_fields.update({"applied_at":null}).eq("request_id", 11).in("field", ["venue"])",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("reject", () => {
    const rejectReply = (overrides: Responder = {}, event: Record<string, unknown> = {}): Responder => ({
      "events.select": (call) =>
        String(call.ops[0][1][0]).includes("safety_approval_stale")
          ? { data: stateRow(event) }
          : { data: { id: 7, organiser_id: "ORG-1", submitted_details: details } },
      "change_requests.select": (call) => (call.ops[0][1][1] ? { count: 1 } : { data: { id: 11, status: "Pending" } }),
      "change_request_fields.select": { data: [held("venue", "Hall", "Park")] },
      "change_requests.update": { data: { id: 11, status: "Rejected", decided_at: "2026-01-01T00:00:00.000Z", decision_reason: "Too late" } },
      ...overrides,
    });

    it("needs a reason", async () => {
      expect(await reject({}, { reply: rejectReply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "A reason is required",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
          ],
          "published": [],
          "status": 400,
        }
      `);
      for (const body of [{}, { reason: "   " }, { reason: 5 }, { reason: null }]) {
        expect([body, (await reject(body, { reply: rejectReply() })).status]).toEqual([body, 400]);
      }
      // no body at all: req.body is undefined
      const bare = await send("post", "/api/events/7/change-requests/11/reject", { user: coordinator, reply: rejectReply() });
      expect([bare.status, bare.body]).toEqual([400, { error: "A reason is required" }]);
    });

    it("500s when the decision cannot be recorded", async () => {
      expect(await reject({ reason: "No" }, { reply: rejectReply({ "change_requests.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to record the decision",
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
            "change_requests.update({"status":"Rejected","decision_reason":"No","decided_by":"COORD-1","decided_at":"2026-01-01T00:00:00.000Z"}).eq("id", 11).select("id, status, decided_at, decision_reason").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("records the trimmed reason and tells the organiser", async () => {
      const outcome = await reject({ reason: "  Too late  " }, { reply: rejectReply() });
      expect(outcome).toMatchInlineSnapshot(`
        {
          "body": {
            "changeRequest": {
              "decided_at": "2026-01-01T00:00:00.000Z",
              "decision_reason": "Too late",
              "id": 11,
              "status": "Rejected",
            },
            "notificationsFailed": false,
            "returnedToConfirmed": false,
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
            "change_requests.update({"status":"Rejected","decision_reason":"Too late","decided_by":"COORD-1","decided_at":"2026-01-01T00:00:00.000Z"}).eq("id", 11).select("id, status, decided_at, decision_reason").single()",
            "change_requests.select("id", {"count":"exact","head":true}).eq("event_id", 7).eq("status", "Pending")",
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
          ],
          "published": [
            {
              "actorId": "COORD-1",
              "data": {
                "eventName": "Film Night",
                "outcome": "rejected",
                "reason": "Too late",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "ORG-1",
                ],
              },
              "type": "change.decided",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("returns a Needs Review event straight to Confirmed when no request is left and nothing was approved", async () => {
      const reply = rejectReply({
        "change_requests.select": (call) => (call.ops[0][1][1] ? { count: 0 } : { data: { id: 11, status: "Pending" } }),
        "events.update": { data: [{ id: 7 }] },
      });
      expect(await reject({ reason: "No" }, { reply })).toMatchInlineSnapshot(`
        {
          "body": {
            "changeRequest": {
              "decided_at": "2026-01-01T00:00:00.000Z",
              "decision_reason": "Too late",
              "id": 11,
              "status": "Rejected",
            },
            "notificationsFailed": false,
            "returnedToConfirmed": true,
          },
          "calls": [
            "events.select("id, status, safety_approval_stale, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id, status").eq("id", 11).eq("event_id", 7).maybeSingle()",
            "change_request_fields.select("field, old_value, new_value, is_critical").eq("request_id", 11).is("applied_at", null)",
            "change_requests.update({"status":"Rejected","decision_reason":"No","decided_by":"COORD-1","decided_at":"2026-01-01T00:00:00.000Z"}).eq("id", 11).select("id, status, decided_at, decision_reason").single()",
            "change_requests.select("id", {"count":"exact","head":true}).eq("event_id", 7).eq("status", "Pending")",
            "events.update({"status":"Confirmed"}).eq("id", 7).eq("status", "Needs Review").eq("safety_approval_stale", false).select("id")",
            "event_history.insert([{"event_id":7,"field":"Status","old_value":"Needs Review","new_value":"Confirmed","changed_by":"COORD-1"}])",
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
          ],
          "published": [
            {
              "actorId": "COORD-1",
              "data": {
                "eventName": "Film Night",
                "outcome": "rejected",
                "reason": "No",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "ORG-1",
                ],
              },
              "type": "change.decided",
            },
          ],
          "status": 200,
        }
      `);
      // a count that comes back empty means none left too
      const unknown = rejectReply({
        "change_requests.select": (call) => (call.ops[0][1][1] ? {} : { data: { id: 11, status: "Pending" } }),
        "events.update": { data: [{ id: 7 }] },
      });
      expect(((await reject({ reason: "No" }, { reply: unknown })).body as any).returnedToConfirmed).toBe(true);
    });

    it("leaves the status alone while another request is open, when the approval went stale, or off Needs Review", async () => {
      const open = await reject({ reason: "No" }, { reply: rejectReply({ "events.update": { data: [{ id: 7 }] } }) });
      expect((open.body as any).returnedToConfirmed).toBe(false);
      expect(open.calls.some((call) => call.startsWith("events.update"))).toBe(false);
      const stale = await reject(
        { reason: "No" },
        { reply: rejectReply({ "change_requests.select": (call) => (call.ops[0][1][1] ? { count: 0 } : { data: { id: 11, status: "Pending" } }), "events.update": { data: [] } }, { safety_approval_stale: true }) },
      );
      expect((stale.body as any).returnedToConfirmed).toBe(false);
      expect(stale.calls.some((call) => call.startsWith("event_history"))).toBe(false);
      const nothing = await reject(
        { reason: "No" },
        { reply: rejectReply({ "change_requests.select": (call) => (call.ops[0][1][1] ? { count: 0 } : { data: { id: 11, status: "Pending" } }), "events.update": { data: null } }) },
      );
      expect((nothing.body as any).returnedToConfirmed).toBe(false);
      const planning = await reject({ reason: "No" }, { reply: rejectReply({}, { status: "Confirmed" }) });
      expect(planning.calls.some((call) => call.includes("count"))).toBe(false);
    });

    it("still answers when the event cannot be read back, naming it by number and telling no one", async () => {
      const reply = rejectReply({
        "events.select": (call) => (String(call.ops[0][1][0]).includes("safety_approval_stale") ? { data: stateRow() } : { data: null }),
      });
      const outcome = await reject({ reason: "No" }, { reply });
      expect(outcome.status).toBe(200);
      expect(outcome.published).toEqual([]);
      expect((outcome.body as any).notificationsFailed).toBe(false);
    });

    it("reports a failed notification", async () => {
      const outcome = await reject({ reason: "No" }, { reply: rejectReply(), publishOk: false });
      expect((outcome.body as any).notificationsFailed).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Coordinator review routes: the shared gate, approve, reject, complete, registration  (E1-4.2, E3-5, E6)
// ---------------------------------------------------------------------------------------------

describe("coordinator review routes", () => {
  const post = (path: string, body: unknown = {}, options: Parameters<typeof send>[2] = {}) =>
    send("post", `/api/events/7/${path}`, { user: coordinator, body, ...options });
  const put = (path: string, body: unknown = {}, options: Parameters<typeof send>[2] = {}) =>
    send("put", `/api/events/7/${path}`, { user: coordinator, body, ...options });
  const row = (status: string, overrides: Record<string, unknown> = {}) =>
    eventRow({ status, registration_open_date: null, registration_override: null, ...overrides });
  /** Same events.select for the gate and the later reads; `registration` reads can be answered differently. */
  const replyFor = (status: string, overrides: Record<string, unknown> = {}, extra: Responder = {}): Responder => ({
    "events.select": { data: row(status, overrides) },
    "events.update": { data: { id: 7, status: "Planning", organiser_id: "ORG-1", submitted_details: details } },
    ...extra,
  });

  describe("the gate every one of them shares", () => {
    it("turns away a caller with no user or no client", async () => {
      expect(await post("approve", {}, { user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect(await post("approve", {}, { noClient: true })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
    });

    it("is for coordinators only", async () => {
      expect(await post("approve", {}, { user: organiser, reply: replyFor("Requested") })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Only coordinators can review event requests",
          },
          "calls": [],
          "published": [],
          "status": 403,
        }
      `);
    });

    it("404s a malformed or unknown event and 500s a failed lookup", async () => {
      expect(await send("post", "/api/events/abc/approve", { user: coordinator })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [],
          "published": [],
          "status": 404,
        }
      `);
      expect(await post("approve", {}, { reply: {} })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 404,
        }
      `);
      expect(await post("approve", {}, { reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load event",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("refuses an unassigned event, another coordinator's event and a rejected one, recording the first two", async () => {
      expect(await post("approve", {}, { reply: replyFor("Requested", { coordinator_id: null }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This request hasn't been assigned to a coordinator yet. The Event Coordinator Lead assigns it.",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "access_denials.insert({"user_id":"COORD-1","event_id":"7","reason":"coordinator_not_assigned"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
      expect(await post("approve", {}, { reply: replyFor("Requested", { coordinator_id: "COORD-2" }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This request is assigned to another coordinator",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "access_denials.insert({"user_id":"COORD-1","event_id":"7","reason":"coordinator_mismatch"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
      expect(await post("approve", {}, { reply: replyFor("Rejected") })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This request has been rejected and cannot be moved forward",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });
  });

  describe("approve", () => {
    it("approves a Requested event: Planning, who and when, and the organiser is told", async () => {
      expect(await post("approve", {}, { reply: replyFor("Requested") })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "organiser_id": "ORG-1",
              "status": "Planning",
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.update({"status":"Planning","decided_at":"2026-01-01T00:00:00.000Z","decided_by":"COORD-1"}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [
            {
              "actorId": "COORD-1",
              "data": {
                "decision": "approved",
                "eventName": "Film Night",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "ORG-1",
                ],
              },
              "type": "request.decided",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("tells nobody when the event has no organiser", async () => {
      const outcome = await post("approve", {}, { reply: replyFor("Requested", { organiser_id: null }) });
      expect([outcome.status, outcome.published]).toEqual([200, []]);
    });

    it("refuses every other status, except Clarification Requested once its questions are settled", async () => {
      for (const status of ["Draft", "Unassigned", "Planning", "Safety Review", "Confirmed", "Needs Review", "Completed", "Cancelled"]) {
        const outcome = await post("approve", {}, { reply: replyFor(status) });
        expect([status, outcome.status, outcome.body, outcome.calls.length]).toEqual([
          status,
          409,
          { error: "This request cannot be approved from its current status" },
          1,
        ]);
      }
    });

    it("approves a Clarification Requested event only when every question is resolved", async () => {
      const asking = (data: unknown, error?: unknown): Responder => replyFor("Clarification Requested", {}, { "event_clarifications.select": { data, error } as Reply });
      expect(await post("approve", {}, { reply: asking([{ id: 1, resolved: true }, { id: 2, resolved: false }]) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This request has an outstanding clarification request and cannot be approved yet",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, resolved").eq("event_id", 7).is("parent_id", null)",
          ],
          "published": [],
          "status": 409,
        }
      `);
      expect((await post("approve", {}, { reply: asking([{ id: 1, resolved: false }]) })).status).toBe(409);
      expect(await post("approve", {}, { reply: asking([{ id: 1, resolved: true }, { id: 2, resolved: true }]) })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "organiser_id": "ORG-1",
              "status": "Planning",
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, resolved").eq("event_id", 7).is("parent_id", null)",
            "events.update({"status":"Planning","decided_at":"2026-01-01T00:00:00.000Z","decided_by":"COORD-1"}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [
            {
              "actorId": "COORD-1",
              "data": {
                "decision": "approved",
                "eventName": "Film Night",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "ORG-1",
                ],
              },
              "type": "request.decided",
            },
          ],
          "status": 200,
        }
      `);
      // no questions at all, or none returned, leaves nothing outstanding
      expect((await post("approve", {}, { reply: asking([]) })).status).toBe(200);
      expect((await post("approve", {}, { reply: asking(null) })).status).toBe(200);
      expect(await post("approve", {}, { reply: asking(null, { message: "x" }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to check the clarification thread",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, resolved").eq("event_id", 7).is("parent_id", null)",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("500s when the update fails", async () => {
      expect(await post("approve", {}, { reply: replyFor("Requested", {}, { "events.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to approve event request",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.update({"status":"Planning","decided_at":"2026-01-01T00:00:00.000Z","decided_by":"COORD-1"}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("reject", () => {
    it("rejects from Requested or Clarification Requested with the reason, and tells the organiser", async () => {
      expect(await post("reject", { reason: "  Not suitable  " }, { reply: replyFor("Requested") })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "organiser_id": "ORG-1",
              "status": "Planning",
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.update({"status":"Rejected","review_outcome":"Not suitable","decided_at":"2026-01-01T00:00:00.000Z","decided_by":"COORD-1"}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_history.insert([{"event_id":7,"field":"Status","old_value":"Requested","new_value":"Rejected","changed_by":"COORD-1"},{"event_id":7,"field":"Rejection reason","old_value":null,"new_value":"Not suitable","changed_by":"COORD-1"}])",
            "event_outbox.insert({"type":"event.rejected","event_id":7,"actor_id":"COORD-1","recipients":{"userIds":[],"roles":[]},"data":{"eventName":"Film Night","reason":"Not suitable"}}).select("id, message_id, type, event_id, actor_id, recipients, data, occurred_at").single()",
          ],
          "published": [
            {
              "actorId": "COORD-1",
              "data": {
                "eventName": "Film Night",
                "reason": "Not suitable",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [],
              },
              "type": "event.rejected",
            },
            {
              "actorId": "COORD-1",
              "data": {
                "decision": "rejected",
                "eventName": "Film Night",
                "reason": "Not suitable",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "ORG-1",
                ],
              },
              "type": "request.decided",
            },
          ],
          "status": 200,
        }
      `);
      expect((await post("reject", { reason: "No" }, { reply: replyFor("Clarification Requested") })).status).toBe(200);
    });

    it("refuses every other status", async () => {
      for (const status of ["Draft", "Unassigned", "Planning", "Safety Review", "Confirmed", "Needs Review", "Completed", "Cancelled"]) {
        const outcome = await post("reject", { reason: "No" }, { reply: replyFor(status) });
        expect([status, outcome.status, outcome.body]).toEqual([status, 409, { error: "This request cannot be rejected from its current status" }]);
      }
    });

    it("needs a reason, whatever the body", async () => {
      expect(await post("reject", {}, { reply: replyFor("Requested") })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "A reason is required to reject a request",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      for (const body of [{ reason: "   " }, { reason: 5 }, { reason: null }]) {
        expect([body, (await post("reject", body, { reply: replyFor("Requested") })).status]).toEqual([body, 400]);
      }
      const bare = await send("post", "/api/events/7/reject", { user: coordinator, reply: replyFor("Requested") });
      expect([bare.status, bare.body]).toEqual([400, { error: "A reason is required to reject a request" }]);
    });

    it("500s when the update fails, and tells nobody when the event has no organiser", async () => {
      expect(await post("reject", { reason: "No" }, { reply: replyFor("Requested", {}, { "events.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to reject event request",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.update({"status":"Rejected","review_outcome":"No","decided_at":"2026-01-01T00:00:00.000Z","decided_by":"COORD-1"}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
      const outcome = await post("reject", { reason: "No" }, { reply: replyFor("Requested", { organiser_id: null }) });
      // No organiser to tell, so only the message that releases the event's arrangements goes out.
      expect([outcome.status, (outcome.published as { type: string }[]).map((message) => message.type)]).toEqual([200, ["event.rejected"]]);
    });
  });

  describe("complete", () => {
    const over = { proposedDate: "2025-12-31", endTime: "17:00" };

    it("only completes a Confirmed event", async () => {
      expect(await post("complete", {}, { reply: replyFor("Planning", { submitted_details: over }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Only a Confirmed event can be marked completed",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });

    it("500s when the event cannot be read again", async () => {
      expect(
        await post("complete", {}, { reply: { ...replyFor("Confirmed", { submitted_details: over }), "events.select": (call) => (call.ops.some(([name]) => name === "single") ? { error: { message: "x" } } : { data: row("Confirmed") }) } }),
      ).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load event",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details").eq("id", 7).single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("waits for the end time and says when that is", async () => {
      expect(await post("complete", {}, { reply: replyFor("Confirmed", { submitted_details: { proposedDate: "2099-01-01", endTime: "12:00" } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event hasn't finished yet. It can be marked completed after it ends (2099-01-01 12:00).",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details").eq("id", 7).single()",
          ],
          "published": [],
          "status": 409,
        }
      `);
      expect(((await post("complete", {}, { reply: replyFor("Confirmed", { submitted_details: { proposedDate: "2099-01-01" } }) })).body as any).error).toBe(
        "This event hasn't finished yet. It can be marked completed after it ends (2099-01-01 end of day).",
      );
      expect(await post("complete", {}, { reply: replyFor("Confirmed", { submitted_details: { endTime: "12:00" } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event has no valid date and end time, so it can't be marked completed.",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details").eq("id", 7).single()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });

    it("completes a finished event and records it", async () => {
      expect(await post("complete", {}, { reply: replyFor("Confirmed", { submitted_details: over }, { "events.update": { data: { id: 7, status: "Completed" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "status": "Completed",
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details").eq("id", 7).single()",
            "events.update({"status":"Completed"}).eq("id", 7).eq("status", "Confirmed").eq("coordinator_id", "COORD-1").select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
            "event_history.insert([{"event_id":7,"field":"Status","old_value":"Confirmed","new_value":"Completed","changed_by":"COORD-1"}])",
          ],
          "published": [],
          "status": 200,
        }
      `);
    });

    it("answers 500 when the update fails and 409 when nothing matched it any more", async () => {
      expect(await post("complete", {}, { reply: replyFor("Confirmed", { submitted_details: over }, { "events.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to mark the event completed",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details").eq("id", 7).single()",
            "events.update({"status":"Completed"}).eq("id", 7).eq("status", "Confirmed").eq("coordinator_id", "COORD-1").select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await post("complete", {}, { reply: replyFor("Confirmed", { submitted_details: over }, { "events.update": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event is no longer Confirmed or no longer assigned to you",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details").eq("id", 7).single()",
            "events.update({"status":"Completed"}).eq("id", 7).eq("status", "Confirmed").eq("coordinator_id", "COORD-1").select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });
  });

  describe("registration open date (PUT)", () => {
    const planned = (overrides: Record<string, unknown> = {}, extra: Responder = {}) => replyFor("Planning", overrides, { "events.update": { data: { id: 7 } }, ...extra });

    it("only works from the editable statuses", async () => {
      for (const status of ["Draft", "Unassigned", "Requested", "Clarification Requested", "Completed", "Cancelled"]) {
        const outcome = await put("registration", { openDate: "2099-01-01" }, { reply: replyFor(status) });
        expect([status, outcome.status, outcome.calls.length]).toEqual([status, 409, 1]);
      }
      for (const status of ["Planning", "Safety Review", "Confirmed", "Needs Review"]) {
        expect([status, (await put("registration", { openDate: "2099-01-01" }, { reply: replyFor(status, {}, { "events.update": { data: { id: 7 } } }) })).status]).toEqual([status, 200]);
      }
      expect(await put("registration", { openDate: "2099-01-01" }, { reply: replyFor("Requested") })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "The registration open date can only be set once the event is in Planning, and before it ends",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });

    it("500s when the registration fields cannot be read", async () => {
      const reply = planned({}, { "events.select": (call) => (String(call.ops[0][1][0]).includes("registration_open_date") ? { data: null } : { data: row("Planning") }) });
      expect(await put("registration", { openDate: "2099-01-01" }, { reply })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load event",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details, registration_open_date, registration_override").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("needs an event that takes registrations", async () => {
      expect(await put("registration", { openDate: "2099-01-01" }, { reply: planned({ submitted_details: { ...details, registrationNeeded: false } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event doesn't need registration",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details, registration_open_date, registration_override").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
      expect((await put("registration", { openDate: "2099-01-01" }, { reply: planned({ submitted_details: { ...details, registrationNeeded: "yes" } }) })).status).toBe(409);
      expect((await put("registration", { openDate: "2099-01-01" }, { reply: planned({ submitted_details: null }) })).status).toBe(409);
    });

    it("needs a real date", async () => {
      expect(await put("registration", { openDate: "soon" }, { reply: planned() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "openDate must be a date in YYYY-MM-DD format",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details, registration_open_date, registration_override").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      for (const body of [{}, { openDate: 20990101 }, { openDate: "2099-13-01" }, { openDate: "2099-1-1" }]) {
        expect([body, (await put("registration", body, { reply: planned() })).status]).toEqual([body, 400]);
      }
      const bare = await send("put", "/api/events/7/registration", { user: coordinator, reply: planned() });
      expect(bare.status).toBe(400);
    });

    it("must be earlier than the cutoff, 5 days before the start, to the minute", async () => {
      const midnight = { ...details, startTime: "00:00", proposedDate: "2099-06-01" };
      // the cutoff is 2099-05-27 00:00 Singapore time: that day itself is too late, the day before is fine
      expect(await put("registration", { openDate: "2099-05-27" }, { reply: planned({ submitted_details: midnight }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Registration closes 5 days before the event, so the open date must be earlier than that",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details, registration_open_date, registration_override").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      expect((await put("registration", { openDate: "2099-05-28" }, { reply: planned({ submitted_details: midnight }) })).status).toBe(400);
      expect((await put("registration", { openDate: "2099-05-26" }, { reply: planned({ submitted_details: midnight }) })).status).toBe(200);
      // an event with no readable start has no cutoff to check
      expect((await put("registration", { openDate: "2099-05-28" }, { reply: planned({ submitted_details: { registrationNeeded: true } }) })).status).toBe(200);
    });

    it("saves the date and records the change", async () => {
      expect(await put("registration", { openDate: "2099-05-01" }, { reply: planned({ registration_open_date: "2099-04-01" }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details, registration_open_date, registration_override").eq("id", 7).maybeSingle()",
            "events.update({"registration_open_date":"2099-05-01"}).eq("id", 7).eq("coordinator_id", "COORD-1").in("status", ["Planning","Safety Review","Confirmed","Needs Review"]).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
            "event_history.insert([{"event_id":7,"field":"Registration open date","old_value":"2099-04-01","new_value":"2099-05-01","changed_by":"COORD-1"}])",
          ],
          "published": [],
          "status": 200,
        }
      `);
    });

    it("answers 500 when the save fails and 409 when the event moved on", async () => {
      expect(await put("registration", { openDate: "2099-05-01" }, { reply: planned({}, { "events.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to save the registration open date",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details, registration_open_date, registration_override").eq("id", 7).maybeSingle()",
            "events.update({"registration_open_date":"2099-05-01"}).eq("id", 7).eq("coordinator_id", "COORD-1").in("status", ["Planning","Safety Review","Confirmed","Needs Review"]).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await put("registration", { openDate: "2099-05-01" }, { reply: planned({}, { "events.update": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event changed or is no longer assigned to you",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details, registration_open_date, registration_override").eq("id", 7).maybeSingle()",
            "events.update({"registration_open_date":"2099-05-01"}).eq("id", 7).eq("coordinator_id", "COORD-1").in("status", ["Planning","Safety Review","Confirmed","Needs Review"]).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });
  });

  describe("registration override (open / close / auto)", () => {
    const confirmed = (overrides: Record<string, unknown> = {}, extra: Responder = {}) =>
      replyFor("Confirmed", overrides, { "events.update": { data: { id: 7, registration_override: "FORCE_OPEN" } }, ...extra });

    it("needs a Confirmed event", async () => {
      for (const action of ["open", "close", "auto"]) {
        for (const status of ["Planning", "Safety Review", "Needs Review", "Completed"]) {
          const outcome = await post(`registration/${action}`, {}, { reply: replyFor(status) });
          expect([action, status, outcome.status, outcome.body]).toEqual([action, status, 409, { error: "Registration can only be opened or closed for a Confirmed event" }]);
        }
      }
    });

    it("500s when the registration fields cannot be read", async () => {
      const reply = confirmed({}, { "events.select": (call) => (String(call.ops[0][1][0]).includes("registration_open_date") ? { data: null } : { data: row("Confirmed") }) });
      expect(await post("registration/open", {}, { reply })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load event",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details, registration_open_date, registration_override").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("needs an event that takes registrations", async () => {
      expect(await post("registration/close", {}, { reply: confirmed({ submitted_details: { ...details, registrationNeeded: false } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event doesn't need registration",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details, registration_open_date, registration_override").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
      expect((await post("registration/auto", {}, { reply: confirmed({ submitted_details: null }) })).status).toBe(409);
    });

    it("opens, closes or resets registration and records the change", async () => {
      expect(await post("registration/open", {}, { reply: confirmed() })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "registration_override": "FORCE_OPEN",
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details, registration_open_date, registration_override").eq("id", 7).maybeSingle()",
            "events.update({"registration_override":"FORCE_OPEN"}).eq("id", 7).eq("status", "Confirmed").eq("coordinator_id", "COORD-1").select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
            "event_history.insert([{"event_id":7,"field":"Registration override","old_value":"NONE","new_value":"FORCE_OPEN","changed_by":"COORD-1"}])",
          ],
          "published": [],
          "status": 200,
        }
      `);
      for (const [action, value] of [["close", "FORCE_CLOSED"], ["auto", "NONE"]]) {
        const outcome = await post(`registration/${action}`, {}, { reply: confirmed({ registration_override: "FORCE_OPEN" }) });
        expect(outcome.calls[2]).toContain(`"registration_override":"${value}"`);
        expect(outcome.calls[3]).toContain(`"old_value":"FORCE_OPEN","new_value":"${value}"`);
      }
      // nothing stored before reads as NONE
      expect((await post("registration/close", {}, { reply: confirmed({ registration_override: null }) })).calls[3]).toContain('"old_value":"NONE"');
    });

    it("will not force registration open once the event has started, to the minute, but still closes or resets it", async () => {
      // the clock reads 2026-01-01 08:00 Singapore time
      const startingNow = { ...details, proposedDate: "2026-01-01", startTime: "08:00", endTime: "09:00" };
      const justAfter = { ...startingNow, startTime: "08:01" };
      expect(await post("registration/open", {}, { reply: confirmed({ submitted_details: startingNow }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event has already started, so registration can't be opened",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details, registration_open_date, registration_override").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
      expect((await post("registration/open", {}, { reply: confirmed({ submitted_details: justAfter }) })).status).toBe(200);
      expect((await post("registration/close", {}, { reply: confirmed({ submitted_details: startingNow }) })).status).toBe(200);
      expect((await post("registration/auto", {}, { reply: confirmed({ submitted_details: startingNow }) })).status).toBe(200);
      // no readable start: nothing to compare with
      expect((await post("registration/open", {}, { reply: confirmed({ submitted_details: { registrationNeeded: true } }) })).status).toBe(200);
    });

    it("answers 500 when the update fails and 409 when the event moved on", async () => {
      expect(await post("registration/open", {}, { reply: confirmed({}, { "events.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to update registration",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details, registration_open_date, registration_override").eq("id", 7).maybeSingle()",
            "events.update({"registration_override":"FORCE_OPEN"}).eq("id", 7).eq("status", "Confirmed").eq("coordinator_id", "COORD-1").select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await post("registration/open", {}, { reply: confirmed({}, { "events.update": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event is no longer Confirmed or no longer assigned to you",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.select("submitted_details, registration_open_date, registration_override").eq("id", 7).maybeSingle()",
            "events.update({"registration_override":"FORCE_OPEN"}).eq("id", 7).eq("status", "Confirmed").eq("coordinator_id", "COORD-1").select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The clarification thread: request-clarification, GET/POST /clarifications, replies, resolve, GET /history  (E1-4.2, E2-10)
// ---------------------------------------------------------------------------------------------

describe("clarification thread", () => {
  const lead = { id: "LEAD-1", role: "coordinator_lead" };
  const stranger = { id: "ORG-2", role: "organiser" };
  const otherCoordinator = { id: "COORD-2", role: "coordinator" };
  const base = "/api/events/7";
  const row = (status: string, overrides: Record<string, unknown> = {}) => eventRow({ status, ...overrides });
  const question = (overrides: Record<string, unknown> = {}) => ({ id: 5, event_id: 7, parent_id: null, resolved: false, ...overrides });
  const entry = (overrides: Record<string, unknown> = {}) => ({
    id: 9,
    parent_id: 5,
    author_id: "ORG-1",
    author_role: "organiser",
    message: "ok",
    resolved: false,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
  const reply = (status = "Clarification Requested", extra: Responder = {}, overrides: Record<string, unknown> = {}): Responder => ({
    "events.select": { data: row(status, overrides) },
    "event_clarifications.select": { data: question() },
    "event_clarifications.insert": { data: entry() },
    "event_clarifications.update": { data: entry({ id: 5, parent_id: null, resolved: true }) },
    ...extra,
  });

  describe("POST /request-clarification", () => {
    const ask = (body: unknown, options: Parameters<typeof send>[2] = {}) => send("post", `${base}/request-clarification`, { user: coordinator, body, ...options });
    const asked = (status = "Requested", extra: Responder = {}, overrides: Record<string, unknown> = {}): Responder => ({
      "events.select": { data: row(status, overrides) },
      "events.update": { data: { id: 7, organiser_id: "ORG-1", submitted_details: details } },
      ...extra,
    });

    it("works from Requested and Planning only", async () => {
      for (const status of ["Draft", "Unassigned", "Clarification Requested", "Safety Review", "Confirmed", "Needs Review", "Completed", "Cancelled"]) {
        const outcome = await ask({ message: "Why?" }, { reply: asked(status) });
        expect([status, outcome.status, outcome.body]).toEqual([status, 409, { error: "Clarification can only be requested while this request is pending review" }]);
      }
      expect(await ask({ message: "Why?" }, { reply: asked("Planning") })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "organiser_id": "ORG-1",
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.update({"status":"Clarification Requested","status_before_clarification":"Planning","review_outcome":"Why?","decided_at":"2026-01-01T00:00:00.000Z","decided_by":"COORD-1"}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_clarifications.insert({"event_id":7,"author_id":"COORD-1","author_role":"coordinator","message":"Why?"})",
          ],
          "published": [
            {
              "actorId": "COORD-1",
              "data": {
                "eventName": "Film Night",
                "message": "Why?",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "ORG-1",
                ],
              },
              "type": "clarification.requested",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("needs a message", async () => {
      expect(await ask({}, { reply: asked() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "A message is required to request clarification",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      for (const body of [{ message: "   " }, { message: 5 }, { message: null }]) {
        expect([body, (await ask(body, { reply: asked() })).status]).toEqual([body, 400]);
      }
      expect((await send("post", `${base}/request-clarification`, { user: coordinator, reply: asked() })).status).toBe(400);
    });

    it("flags the event, seeds the thread with the trimmed question and tells the organiser", async () => {
      expect(await ask({ message: "  Which hall?  " }, { reply: asked() })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "organiser_id": "ORG-1",
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.update({"status":"Clarification Requested","status_before_clarification":"Requested","review_outcome":"Which hall?","decided_at":"2026-01-01T00:00:00.000Z","decided_by":"COORD-1"}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
            "event_clarifications.insert({"event_id":7,"author_id":"COORD-1","author_role":"coordinator","message":"Which hall?"})",
          ],
          "published": [
            {
              "actorId": "COORD-1",
              "data": {
                "eventName": "Film Night",
                "message": "Which hall?",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "ORG-1",
                ],
              },
              "type": "clarification.requested",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("500s when the event cannot be updated, writing nothing else", async () => {
      expect(await ask({ message: "Why?" }, { reply: asked("Requested", { "events.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to request clarification",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "events.update({"status":"Clarification Requested","status_before_clarification":"Requested","review_outcome":"Why?","decided_at":"2026-01-01T00:00:00.000Z","decided_by":"COORD-1"}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("carries on and logs when the thread entry cannot be saved", async () => {
      const outcome = await ask({ message: "Why?" }, { reply: asked("Requested", { "event_clarifications.insert": { error: { message: "x" } } }) });
      expect(outcome.status).toBe(200);
      expect(outcome.published).toHaveLength(1);
      expect(console.error).toHaveBeenCalledWith("Failed to record clarification thread entry", { eventId: 7, error: { message: "x" } });
    });

    it("tells nobody when the event has no organiser, and does not log a success", async () => {
      const outcome = await ask({ message: "Why?" }, { reply: asked("Requested", {}, { organiser_id: null }) });
      expect([outcome.status, outcome.published]).toEqual([200, []]);
      expect(console.error).not.toHaveBeenCalled();
    });
  });

  describe("who may read an event's thread and history (the shared visibility check)", () => {
    const read = (path: string, options: Parameters<typeof send>[2] = {}) => send("get", `${base}/${path}`, options);
    const visible = (status: string, overrides: Record<string, unknown> = {}): Responder => ({
      "events.select": { data: row(status, overrides) },
      "event_clarifications.select": { data: [entry()] },
      "event_history.select": { data: [{ id: 1 }] },
    });

    it("turns away a caller with no user or no client", async () => {
      expect(await read("clarifications", { user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect(await read("history", { noClient: true })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
    });

    it("404s a malformed id and 500s a failed lookup", async () => {
      expect(await send("get", "/api/events/abc/clarifications")).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [],
          "published": [],
          "status": 404,
        }
      `);
      expect(await read("clarifications", { reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load event",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("lets the owner, any coordinator and the Lead in, and records everyone else", async () => {
      for (const [who, user] of [["owner", organiser], ["coordinator", otherCoordinator], ["lead", lead]] as const) {
        expect([who, (await read("clarifications", { user, reply: visible("Planning") })).status]).toEqual([who, 200]);
      }
      expect(await read("clarifications", { user: stranger, reply: visible("Planning") })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "access_denials.insert({"user_id":"ORG-2","event_id":"7","reason":"not_found_or_not_owner"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
      // an event that does not exist reads as no access, and is recorded the same way
      expect(await read("clarifications", { reply: {} })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "access_denials.insert({"user_id":"ORG-1","event_id":"7","reason":"not_found_or_not_owner"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
      expect((await read("clarifications", { user: { id: "X-1", role: "attendee" }, reply: visible("Planning") })).status).toBe(403);
    });

    it("keeps a draft to its owner: coordinators and the Lead cannot see it", async () => {
      expect((await read("clarifications", { user: organiser, reply: visible("Draft") })).status).toBe(200);
      expect((await read("clarifications", { user: coordinator, reply: visible("Draft") })).status).toBe(403);
      expect((await read("history", { user: lead, reply: visible("Draft") })).status).toBe(403);
    });

    it("lists the thread oldest first", async () => {
      expect(await read("clarifications", { reply: visible("Planning") })).toMatchInlineSnapshot(`
        {
          "body": {
            "clarifications": [
              {
                "author_id": "ORG-1",
                "author_role": "organiser",
                "created_at": "2026-01-01T00:00:00.000Z",
                "id": 9,
                "message": "ok",
                "parent_id": 5,
                "resolved": false,
              },
            ],
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, parent_id, author_id, author_role, message, resolved, created_at").eq("event_id", 7).order("created_at", {"ascending":true})",
          ],
          "published": [],
          "status": 200,
        }
      `);
      expect((await read("clarifications", { reply: { "events.select": { data: row("Planning") } } })).body).toEqual({ clarifications: [] });
      expect(await read("clarifications", { reply: { ...visible("Planning"), "event_clarifications.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load clarifications",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, parent_id, author_id, author_role, message, resolved, created_at").eq("event_id", 7).order("created_at", {"ascending":true})",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("lists the history oldest first", async () => {
      expect(await read("history", { reply: visible("Planning") })).toMatchInlineSnapshot(`
        {
          "body": {
            "history": [
              {
                "id": 1,
              },
            ],
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "event_history.select("id, field, old_value, new_value, changed_by, changed_by_user:changed_by(name, role), changed_at").eq("event_id", 7).order("changed_at", {"ascending":true})",
          ],
          "published": [],
          "status": 200,
        }
      `);
      expect((await read("history", { reply: { "events.select": { data: row("Planning") } } })).body).toEqual({ history: [] });
      expect(await read("history", { reply: { ...visible("Planning"), "event_history.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load event history",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "event_history.select("id, field, old_value, new_value, changed_by, changed_by_user:changed_by(name, role), changed_at").eq("event_id", 7).order("changed_at", {"ascending":true})",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("POST /clarifications (a follow-up question)", () => {
    const addQuestion = (body: unknown, options: Parameters<typeof send>[2] = {}) => send("post", `${base}/clarifications`, { user: coordinator, body, ...options });

    it("only while clarification is outstanding", async () => {
      for (const status of ["Requested", "Planning", "Confirmed", "Completed"]) {
        const outcome = await addQuestion({ message: "More?" }, { reply: reply(status) });
        expect([status, outcome.status, outcome.body]).toEqual([status, 409, { error: "Additional questions can only be added while clarification is outstanding" }]);
      }
    });

    it("needs a question", async () => {
      expect(await addQuestion({}, { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "A question is required",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      for (const body of [{ message: "  " }, { message: 5 }, { message: null }]) {
        expect([body, (await addQuestion(body, { reply: reply() })).status]).toEqual([body, 400]);
      }
      expect((await send("post", `${base}/clarifications`, { user: coordinator, reply: reply() })).status).toBe(400);
    });

    it("adds the trimmed question as the coordinator", async () => {
      expect(await addQuestion({ message: "  More?  " }, { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "clarification": {
              "author_id": "ORG-1",
              "author_role": "organiser",
              "created_at": "2026-01-01T00:00:00.000Z",
              "id": 9,
              "message": "ok",
              "parent_id": 5,
              "resolved": false,
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "event_clarifications.insert({"event_id":7,"author_id":"COORD-1","author_role":"coordinator","message":"More?"}).select("id, parent_id, author_id, author_role, message, resolved, created_at").single()",
          ],
          "published": [],
          "status": 201,
        }
      `);
    });

    it("500s when it cannot be saved", async () => {
      expect(await addQuestion({ message: "More?" }, { reply: reply("Clarification Requested", { "event_clarifications.insert": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to add question",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "event_clarifications.insert({"event_id":7,"author_id":"COORD-1","author_role":"coordinator","message":"More?"}).select("id, parent_id, author_id, author_role, message, resolved, created_at").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("POST /clarifications/:questionId/replies", () => {
    const answer = (body: unknown, options: Parameters<typeof send>[2] = {}) => send("post", `${base}/clarifications/5/replies`, { user: organiser, body, ...options });

    it("lets only the owner or the assigned coordinator reply", async () => {
      // the shared loader already turns a stranger away (and records it)
      expect((await answer({ message: "Hi" }, { user: stranger, reply: reply() })).status).toBe(403);
      // another coordinator and the Lead may read the thread, but the reply is the owner's or the assigned coordinator's
      expect(await answer({ message: "Hi" }, { user: otherCoordinator, reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 403,
        }
      `);
      // the assigned coordinator's id is not enough without the coordinator role
      expect((await answer({ message: "Hi" }, { user: { id: "COORD-1", role: "coordinator_lead" }, reply: reply() })).status).toBe(403);
      expect((await answer({ message: "Hi" }, { user: coordinator, reply: reply() })).status).toBe(201);
      expect((await answer({ message: "Hi" }, { user: organiser, reply: reply() })).status).toBe(201);
    });

    it("only while clarification is outstanding", async () => {
      expect(await answer({ message: "Hi" }, { reply: reply("Planning") })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This clarification is no longer open for replies",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });

    it("404s a malformed question and 500s a failed read", async () => {
      expect(await send("post", `${base}/clarifications/abc/replies`, { user: organiser, body: { message: "Hi" }, reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Question not found",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 404,
        }
      `);
      expect(await answer({ message: "Hi" }, { reply: reply("Clarification Requested", { "event_clarifications.select": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load question",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, event_id, parent_id, resolved").eq("id", 5).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("404s a question that is missing, on another event, or itself a reply", async () => {
      expect(await answer({ message: "Hi" }, { reply: reply("Clarification Requested", { "event_clarifications.select": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Question not found",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, event_id, parent_id, resolved").eq("id", 5).maybeSingle()",
          ],
          "published": [],
          "status": 404,
        }
      `);
      for (const overrides of [{ event_id: 8 }, { parent_id: 3 }]) {
        const outcome = await answer({ message: "Hi" }, { reply: reply("Clarification Requested", { "event_clarifications.select": { data: question(overrides) } }) });
        expect([overrides, outcome.status, outcome.body]).toEqual([overrides, 404, { error: "Question not found" }]);
      }
    });

    it("409s a resolved question", async () => {
      expect(await answer({ message: "Hi" }, { reply: reply("Clarification Requested", { "event_clarifications.select": { data: question({ resolved: true }) } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This question has been resolved and is no longer open for replies",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, event_id, parent_id, resolved").eq("id", 5).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });

    it("needs a reply", async () => {
      expect(await answer({}, { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "A reply is required",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, event_id, parent_id, resolved").eq("id", 5).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      for (const body of [{ message: " " }, { message: 5 }, { message: null }]) {
        expect([body, (await answer(body, { reply: reply() })).status]).toEqual([body, 400]);
      }
      expect((await send("post", `${base}/clarifications/5/replies`, { user: organiser, reply: reply() })).status).toBe(400);
    });

    it("adds the trimmed reply under the question, in the replier's role", async () => {
      expect(await answer({ message: "  Booked.  " }, { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "clarification": {
              "author_id": "ORG-1",
              "author_role": "organiser",
              "created_at": "2026-01-01T00:00:00.000Z",
              "id": 9,
              "message": "ok",
              "parent_id": 5,
              "resolved": false,
            },
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, event_id, parent_id, resolved").eq("id", 5).maybeSingle()",
            "event_clarifications.insert({"event_id":7,"parent_id":5,"author_id":"ORG-1","author_role":"organiser","message":"Booked."}).select("id, parent_id, author_id, author_role, message, resolved, created_at").single()",
          ],
          "published": [],
          "status": 201,
        }
      `);
      const byCoordinator = await answer({ message: "Thanks" }, { user: coordinator, reply: reply() });
      expect(byCoordinator.calls[2]).toContain('"author_id":"COORD-1","author_role":"coordinator"');
    });

    it("500s when it cannot be saved", async () => {
      expect(await answer({ message: "Hi" }, { reply: reply("Clarification Requested", { "event_clarifications.insert": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to add reply",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, event_id, parent_id, resolved").eq("id", 5).maybeSingle()",
            "event_clarifications.insert({"event_id":7,"parent_id":5,"author_id":"ORG-1","author_role":"organiser","message":"Hi"}).select("id, parent_id, author_id, author_role, message, resolved, created_at").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("POST /clarifications/:questionId/resolve", () => {
    const resolve = (options: Parameters<typeof send>[2] = {}) => send("post", `${base}/clarifications/5/resolve`, { user: coordinator, body: {}, ...options });

    it("only while clarification is outstanding", async () => {
      expect(await resolve({ reply: reply("Planning") })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Questions can only be resolved while clarification is outstanding",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });

    it("404s a malformed question and 500s a failed read", async () => {
      expect(await send("post", `${base}/clarifications/abc/resolve`, { user: coordinator, reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Question not found",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 404,
        }
      `);
      expect(await resolve({ reply: reply("Clarification Requested", { "event_clarifications.select": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load question",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, event_id, parent_id").eq("id", 5).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("404s a question that is missing, on another event, or itself a reply", async () => {
      expect(await resolve({ reply: reply("Clarification Requested", { "event_clarifications.select": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Question not found",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, event_id, parent_id").eq("id", 5).maybeSingle()",
          ],
          "published": [],
          "status": 404,
        }
      `);
      for (const overrides of [{ event_id: 8 }, { parent_id: 3 }]) {
        const outcome = await resolve({ reply: reply("Clarification Requested", { "event_clarifications.select": { data: question(overrides) } }) });
        expect([overrides, outcome.status, outcome.body]).toEqual([overrides, 404, { error: "Question not found" }]);
      }
    });

    it("marks the question resolved", async () => {
      expect(await resolve({ reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "clarification": {
              "author_id": "ORG-1",
              "author_role": "organiser",
              "created_at": "2026-01-01T00:00:00.000Z",
              "id": 5,
              "message": "ok",
              "parent_id": null,
              "resolved": true,
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, event_id, parent_id").eq("id", 5).maybeSingle()",
            "event_clarifications.update({"resolved":true}).eq("id", 5).select("id, parent_id, author_id, author_role, message, resolved, created_at").single()",
          ],
          "published": [],
          "status": 200,
        }
      `);
    });

    it("500s when it cannot be saved", async () => {
      expect(await resolve({ reply: reply("Clarification Requested", { "event_clarifications.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to resolve question",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "event_clarifications.select("id, event_id, parent_id").eq("id", 5).maybeSingle()",
            "event_clarifications.update({"resolved":true}).eq("id", 5).select("id, parent_id, author_id, author_role, message, resolved, created_at").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// POST /:id/assign and /:id/reassign  (E2-12, E2-13)
// ---------------------------------------------------------------------------------------------

describe("assigning and reassigning a coordinator", () => {
  const lead = { id: "LEAD-1", role: "coordinator_lead" };
  const assign = (body: unknown = { coordinatorId: "COORD-2" }, options: Parameters<typeof send>[2] = {}) =>
    send("post", "/api/events/7/assign", { user: lead, body, authorization: "Bearer lead-token", ...options });
  const reassign = (body: unknown = { coordinatorId: "COORD-2" }, options: Parameters<typeof send>[2] = {}) =>
    send("post", "/api/events/7/reassign", { user: lead, body, authorization: "Bearer lead-token", ...options });

  let users: unknown;
  const fetched: [string, unknown][] = [];
  beforeEach(() => {
    fetched.length = 0;
    users = { users: [{ id: "COORD-1", name: "Casey" }, { id: "COORD-2", name: "Dana" }] };
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      fetched.push([url, init.headers.Authorization]);
      return users === null ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => users };
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const row = (overrides: Record<string, unknown> = {}) =>
    eventRow({ status: "Unassigned", coordinator_id: null, coordinator: null, ...overrides });
  const replyFor = (overrides: Record<string, unknown> = {}, extra: Responder = {}): Responder => ({
    "events.select": { data: row(overrides) },
    "events.update": { data: { id: 7, status: "Requested", coordinator_id: "COORD-2" } },
    ...extra,
  });

  describe("the checks both share", () => {
    it("turns away a caller with no user or no client", async () => {
      expect(await assign({}, { user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect(await reassign({}, { noClient: true })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
    });

    it("is for the Lead only, and records anyone else's attempt", async () => {
      expect(await assign({}, { user: coordinator, reply: replyFor() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Only the Event Coordinator Lead can assign or reassign coordinators",
          },
          "calls": [
            "access_denials.insert({"user_id":"COORD-1","event_id":"7","reason":"assignment_role_not_allowed"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
      expect(await reassign({}, { user: organiser, reply: replyFor() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Only the Event Coordinator Lead can assign or reassign coordinators",
          },
          "calls": [
            "access_denials.insert({"user_id":"ORG-1","event_id":"7","reason":"assignment_role_not_allowed"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
    });

    it("404s a malformed event id", async () => {
      expect(await send("post", "/api/events/abc/assign", { user: lead, body: { coordinatorId: "COORD-2" } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [],
          "published": [],
          "status": 404,
        }
      `);
    });

    it("needs a coordinator in the body", async () => {
      expect(await assign({}, { reply: replyFor() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Choose a coordinator",
          },
          "calls": [],
          "published": [],
          "status": 400,
        }
      `);
      for (const body of [{ coordinatorId: "   " }, { coordinatorId: 5 }, { coordinatorId: null }]) {
        expect([body, (await assign(body, { reply: replyFor() })).status]).toEqual([body, 400]);
      }
      expect((await send("post", "/api/events/7/assign", { user: lead, reply: replyFor() })).status).toBe(400);
      // spaces around a real id are ignored
      const padded = await assign({ coordinatorId: "  COORD-2  " }, { reply: replyFor() });
      expect([padded.status, padded.calls[1]]).toEqual([200, expect.stringContaining('"coordinator_id":"COORD-2"')]);
    });

    it("500s a failed lookup and 404s an unknown event or a draft", async () => {
      expect(await assign(undefined, { reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load event",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await assign(undefined, { reply: {} })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 404,
        }
      `);
      expect((await assign(undefined, { reply: replyFor({ status: "Draft" }) })).status).toBe(404);
    });

    it("fails with 502 when the coordinator list cannot be read, and 400 for someone who is not a coordinator", async () => {
      users = null;
      expect(await assign(undefined, { reply: replyFor() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load the list of coordinators",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 502,
        }
      `);
      users = { users: [{ id: "COORD-1", name: "Casey" }] };
      expect(await assign(undefined, { reply: replyFor() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "That user is not an active Event Coordinator",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      users = {};
      expect((await assign(undefined, { reply: replyFor() })).status).toBe(400);
    });

    it("asks user-service for the coordinators with the Lead's own token", async () => {
      await assign(undefined, { reply: replyFor() });
      expect(fetched).toEqual([["http://localhost:4002/api/users?role=coordinator", "Bearer lead-token"]]);
    });
  });

  describe("assign", () => {
    it("assigns an unassigned request: Requested, the coordinator set, history and both told", async () => {
      expect(await assign(undefined, { reply: replyFor({ submitted_details: { ...details, name: "  Film Night  " } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "coordinator_id": "COORD-2",
              "id": 7,
              "status": "Requested",
            },
            "notificationsFailed": false,
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details").eq("id", 7).maybeSingle()",
            "events.update({"status":"Requested","coordinator_id":"COORD-2"}).eq("id", 7).eq("status", "Unassigned").is("coordinator_id", null).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
            "event_history.insert([{"event_id":7,"field":"Coordinator","old_value":null,"new_value":"Dana","changed_by":"LEAD-1"},{"event_id":7,"field":"Status","old_value":"Unassigned","new_value":"Requested","changed_by":"LEAD-1"}])",
          ],
          "published": [
            {
              "actorId": "LEAD-1",
              "data": {
                "coordinatorId": "COORD-2",
                "coordinatorName": "Dana",
                "eventName": "Film Night",
                "organiserId": "ORG-1",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "COORD-2",
                  "ORG-1",
                ],
              },
              "type": "coordinator.assigned",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("refuses an event that already has a coordinator, or is not in the unassigned queue", async () => {
      expect(await assign(undefined, { reply: replyFor({ coordinator_id: "COORD-1" }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event already has a coordinator. An event has at most one — use reassignment instead.",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
      for (const status of ["Requested", "Clarification Requested", "Planning", "Safety Review", "Confirmed", "Needs Review", "Rejected", "Completed", "Cancelled"]) {
        const outcome = await assign(undefined, { reply: replyFor({ status }) });
        expect([status, outcome.status, outcome.body]).toEqual([status, 409, { error: "Only a request in the unassigned queue can be assigned" }]);
      }
    });

    it("answers 500 when the update fails and 409 when someone else got there first", async () => {
      expect(await assign(undefined, { reply: replyFor({}, { "events.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to assign the coordinator",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details").eq("id", 7).maybeSingle()",
            "events.update({"status":"Requested","coordinator_id":"COORD-2"}).eq("id", 7).eq("status", "Unassigned").is("coordinator_id", null).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await assign(undefined, { reply: replyFor({}, { "events.update": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This request was assigned by someone else just now. Refresh to see who.",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details").eq("id", 7).maybeSingle()",
            "events.update({"status":"Requested","coordinator_id":"COORD-2"}).eq("id", 7).eq("status", "Unassigned").is("coordinator_id", null).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });

    it("reports a failed notification without failing the assignment", async () => {
      const outcome = await assign(undefined, { reply: replyFor(), publishOk: false });
      expect([outcome.status, (outcome.body as any).notificationsFailed]).toEqual([200, true]);
    });

    it("names the event in the notice: its trimmed name, or its number when it has none", async () => {
      const name = async (submitted_details: unknown) => ((await assign(undefined, { reply: replyFor({ submitted_details }) })).published[0] as any).data.eventName;
      expect(await name({ name: "  Film Night  " })).toBe("Film Night");
      expect(await name({ name: "   " })).toBe("Event #7");
      expect(await name({ name: 5 })).toBe("Event #7");
      expect(await name({})).toBe("Event #7");
      expect(await name(null)).toBe("Event #7");
    });
  });

  describe("reassign", () => {
    const assigned = (overrides: Record<string, unknown> = {}, extra: Responder = {}) =>
      replyFor({ status: "Planning", coordinator_id: "COORD-1", coordinator: { name: "Casey" }, ...overrides }, extra);

    it("refuses a closed event, naming its status", async () => {
      for (const status of ["Rejected", "Cancelled", "Completed"]) {
        const outcome = await reassign(undefined, { reply: assigned({ status }) });
        expect([status, outcome.status, outcome.body]).toEqual([status, 409, { error: `This event is ${status}. Closed events cannot be reassigned.` }]);
      }
    });

    it("refuses an event with no coordinator, or the same coordinator", async () => {
      expect(await reassign(undefined, { reply: assigned({ coordinator_id: null, coordinator: null }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event has no coordinator yet. Assign one from the unassigned queue instead.",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
      expect(await reassign({ coordinatorId: "COORD-1" }, { reply: assigned() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Choose a different coordinator from the one already assigned",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
    });

    it("hands the event over without changing its status, records it and tells all three", async () => {
      expect(await reassign(undefined, { reply: assigned() })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "coordinator_id": "COORD-2",
              "id": 7,
              "status": "Requested",
            },
            "notificationsFailed": false,
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details").eq("id", 7).maybeSingle()",
            "events.update({"coordinator_id":"COORD-2"}).eq("id", 7).eq("coordinator_id", "COORD-1").eq("status", "Planning").select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
            "event_history.insert([{"event_id":7,"field":"Coordinator","old_value":"Casey","new_value":"Dana","changed_by":"LEAD-1"}])",
          ],
          "published": [
            {
              "actorId": "LEAD-1",
              "data": {
                "eventName": "Film Night",
                "newCoordinatorId": "COORD-2",
                "newCoordinatorName": "Dana",
                "organiserId": "ORG-1",
                "previousCoordinatorId": "COORD-1",
                "previousCoordinatorName": "Casey",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "ORG-1",
                  "COORD-1",
                  "COORD-2",
                ],
              },
              "type": "coordinator.reassigned",
            },
          ],
          "status": 200,
        }
      `);
      // any open status works
      for (const status of ["Requested", "Clarification Requested", "Safety Review", "Confirmed", "Needs Review"]) {
        expect([status, (await reassign(undefined, { reply: assigned({ status }) })).status]).toEqual([status, 200]);
      }
    });

    it("names the previous coordinator by id when their name is unknown", async () => {
      const outcome = await reassign(undefined, { reply: assigned({ coordinator: null }) });
      expect(outcome.calls[2]).toContain('"old_value":"COORD-1"');
      expect((outcome.published[0] as any).data.previousCoordinatorName).toBe("COORD-1");
    });

    it("answers 500 when the update fails and 409 when the event changed meanwhile", async () => {
      expect(await reassign(undefined, { reply: assigned({}, { "events.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to reassign the coordinator",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details").eq("id", 7).maybeSingle()",
            "events.update({"coordinator_id":"COORD-2"}).eq("id", 7).eq("coordinator_id", "COORD-1").eq("status", "Planning").select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await reassign(undefined, { reply: assigned({}, { "events.update": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event changed while you were reassigning it. Refresh and try again.",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details").eq("id", 7).maybeSingle()",
            "events.update({"coordinator_id":"COORD-2"}).eq("id", 7).eq("coordinator_id", "COORD-1").eq("status", "Planning").select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });

    it("reports a failed notification without failing the reassignment", async () => {
      const outcome = await reassign(undefined, { reply: assigned(), publishOk: false });
      expect([outcome.status, (outcome.body as any).notificationsFailed]).toEqual([200, true]);
      expect(((await reassign(undefined, { reply: assigned() })).body as any).notificationsFailed).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// POST /:id/arrangements-changed  (internal: venue-service / equipment-service)
// ---------------------------------------------------------------------------------------------

describe("POST /api/events/:id/arrangements-changed", () => {
  process.env.INTERNAL_SERVICE_SECRET = "contracts-internal-secret";
  const token = () => signWithClock({ svc: "venue-service" }, "contracts-internal-secret", { expiresIn: "60s" });
  const tell = (body: unknown = { reason: "Hall closed" }, options: Parameters<typeof send>[2] = {}) =>
    send("post", "/api/events/7/arrangements-changed", { user: null, body, headers: { "x-internal-auth": token() }, ...options });
  const row = (status: string, overrides: Record<string, unknown> = {}) => eventRow({ status, ...overrides });
  const replyFor = (status: string, overrides: Record<string, unknown> = {}, extra: Responder = {}): Responder => ({
    "events.select": { data: row(status, overrides) },
    "events.update": { data: [{ id: 7 }] },
    ...extra,
  });

  it("needs a valid internal token", async () => {
    expect(await tell({}, { headers: {} })).toMatchInlineSnapshot(`
      {
        "body": {
          "code": "no_internal_token",
          "error": "Missing internal token",
        },
        "calls": [],
        "published": [],
        "status": 401,
      }
    `);
    expect(await tell({}, { headers: { "x-internal-auth": "garbage" } })).toMatchInlineSnapshot(`
      {
        "body": {
          "code": "invalid_internal_token",
          "error": "Invalid internal token",
        },
        "calls": [],
        "published": [],
        "status": 401,
      }
    `);
  });

  it("404s a malformed id and needs a reason", async () => {
    expect(await send("post", "/api/events/abc/arrangements-changed", { user: null, body: { reason: "x" }, headers: { "x-internal-auth": token() } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Event not found",
        },
        "calls": [],
        "published": [],
        "status": 404,
      }
    `);
    expect(await tell({}, { reply: replyFor("Confirmed") })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "A reason is required",
        },
        "calls": [],
        "published": [],
        "status": 400,
      }
    `);
    for (const body of [{ reason: "   " }, { reason: 5 }, { reason: null }]) {
      expect([body, (await tell(body, { reply: replyFor("Confirmed") })).status]).toEqual([body, 400]);
    }
    const bare = await send("post", "/api/events/7/arrangements-changed", { user: null, headers: { "x-internal-auth": token() }, reply: replyFor("Confirmed") });
    expect(bare.status).toBe(400);
  });

  it("500s a failed lookup and 404s an unknown event", async () => {
    expect(await tell(undefined, { reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to load event",
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
        ],
        "published": [],
        "status": 500,
      }
    `);
    expect(await tell(undefined, { reply: {} })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Event not found",
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
        ],
        "published": [],
        "status": 404,
      }
    `);
  });

  it("moves a Confirmed event to Needs Review, marks approval stale and tells the coordinator and organiser", async () => {
    expect(await tell({ reason: "  Hall closed  " }, { reply: replyFor("Confirmed") })).toMatchInlineSnapshot(`
      {
        "body": {
          "changed": true,
          "notificationsFailed": false,
          "status": "Needs Review",
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
          "events.update({"status":"Needs Review","safety_approval_stale":true}).eq("id", 7).eq("status", "Confirmed").select("id")",
        ],
        "published": [
          {
            "actorId": null,
            "data": {
              "eventName": "Film Night",
              "reason": "Hall closed",
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "COORD-1",
                "ORG-1",
              ],
            },
            "type": "event.needs_review",
          },
        ],
        "status": 200,
      }
    `);
  });

  it("returns a Safety Review event to Planning and tells the Safety Officer too", async () => {
    expect(await tell(undefined, { reply: replyFor("Safety Review") })).toMatchInlineSnapshot(`
      {
        "body": {
          "changed": true,
          "notificationsFailed": false,
          "status": "Planning",
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
          "events.update({"status":"Planning","safety_approval_stale":true}).eq("id", 7).eq("status", "Safety Review").select("id")",
        ],
        "published": [
          {
            "actorId": null,
            "data": {
              "eventName": "Film Night",
              "reason": "Hall closed",
            },
            "eventId": 7,
            "recipients": {
              "roles": [
                "safety_officer",
              ],
              "userIds": [
                "COORD-1",
                "ORG-1",
              ],
            },
            "type": "event.returned_to_planning",
          },
        ],
        "status": 200,
      }
    `);
  });

  it("keeps a Needs Review event there, only marking approval stale, with no notice", async () => {
    expect(await tell(undefined, { reply: replyFor("Needs Review") })).toMatchInlineSnapshot(`
      {
        "body": {
          "changed": false,
          "status": "Needs Review",
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
          "events.update({"status":"Needs Review","safety_approval_stale":true}).eq("id", 7).eq("status", "Needs Review").select("id")",
        ],
        "published": [],
        "status": 200,
      }
    `);
  });

  it("does nothing for any other status", async () => {
    for (const status of ["Draft", "Unassigned", "Requested", "Clarification Requested", "Planning", "Rejected", "Completed", "Cancelled"]) {
      const outcome = await tell(undefined, { reply: replyFor(status) });
      expect([status, outcome.status, outcome.body, outcome.calls.length, outcome.published.length]).toEqual([status, 200, { changed: false, status }, 1, 0]);
    }
  });

  it("answers 500 when the update fails and 409 when the event moved on or nothing matched", async () => {
    expect(await tell(undefined, { reply: replyFor("Confirmed", {}, { "events.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to update the event",
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
          "events.update({"status":"Needs Review","safety_approval_stale":true}).eq("id", 7).eq("status", "Confirmed").select("id")",
        ],
        "published": [],
        "status": 500,
      }
    `);
    expect(await tell(undefined, { reply: replyFor("Confirmed", {}, { "events.update": { data: [] } }) })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "The event changed status; try again",
        },
        "calls": [
          "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
          "events.update({"status":"Needs Review","safety_approval_stale":true}).eq("id", 7).eq("status", "Confirmed").select("id")",
        ],
        "published": [],
        "status": 409,
      }
    `);
    expect((await tell(undefined, { reply: replyFor("Confirmed", {}, { "events.update": { data: null } }) })).status).toBe(409);
  });

  it("tells only whoever exists, and reports a failed notification", async () => {
    const who = async (overrides: Record<string, unknown>) => ((await tell(undefined, { reply: replyFor("Confirmed", overrides) })).published[0] as any).recipients.userIds;
    expect(await who({ coordinator_id: null })).toEqual(["ORG-1"]);
    expect(await who({ organiser_id: null })).toEqual(["COORD-1"]);
    expect(await who({ coordinator_id: null, organiser_id: null })).toEqual([]);
    const failed = await tell(undefined, { reply: replyFor("Confirmed"), publishOk: false });
    expect([failed.status, (failed.body as any).notificationsFailed]).toEqual([200, true]);
  });
});

// ---------------------------------------------------------------------------------------------
// Safety review: submit, and the Safety Officer's approve / reject / request-changes  (E3-4, E3-12..14)
// ---------------------------------------------------------------------------------------------

describe("safety review lifecycle", () => {
  const officer = { id: "SO-1", role: "safety_officer" };
  const notes = { equipmentPlacement: "  Near the stage  ", crowdMovement: "Two lanes", emergencyAccess: "Exit A", venueRestrictions: "None known" };
  const fetched: [string, unknown][] = [];
  let services: { bookings: unknown; equipment: unknown };
  const booking = (overrides: Record<string, unknown> = {}) => ({ id: 32, status: "Approved", venue: { id: 1, name: "Seminar Room 3-01" }, ...overrides });
  const equipmentRequest = (fulfilled = 2) => ({ id: 5, status: "Open", items: [{ id: 51, equipmentType: "PA system", quantity: 2, quantityFulfilled: fulfilled }] });
  beforeEach(() => {
    fetched.length = 0;
    services = { bookings: { bookings: [booking()] }, equipment: { equipmentRequests: [equipmentRequest()] } };
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      fetched.push([url, init.headers.Authorization]);
      const body = url.includes("equipment-requests") ? services.equipment : services.bookings;
      return body === null ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => body };
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const row = (status: string, overrides: Record<string, unknown> = {}) => eventRow({ status, ...overrides });
  /** The first events.select is the gate (maybeSingle); the reload after a decision is a .single(). */
  const eventsReply = (gate: unknown, reload: Reply): ((call: Call) => Reply) => (call) =>
    call.ops.some(([name]) => name === "single") ? reload : { data: gate };

  describe("POST /submit-safety-review (coordinator)", () => {
    const submit = (body: unknown = { safetyNotes: notes }, options: Parameters<typeof send>[2] = {}) =>
      send("post", "/api/events/7/submit-safety-review", { user: coordinator, body, authorization: "Bearer coord-token", ...options });
    const ready = (status = "Planning", extra: Responder = {}, overrides: Record<string, unknown> = {}): Responder => ({
      "events.select": eventsReply(row(status, overrides), { data: { id: 7, status: "Safety Review", submitted_details: details, organiser_id: "ORG-1" } }),
      "change_requests.select": { count: 0 },
      "rpc.submit_event_for_safety_review": { data: 88 },
      ...extra,
    });

    it("only from Planning or Needs Review", async () => {
      for (const status of ["Draft", "Unassigned", "Requested", "Clarification Requested", "Safety Review", "Confirmed", "Completed", "Cancelled"]) {
        const outcome = await submit(undefined, { reply: ready(status) });
        expect([status, outcome.status, outcome.body]).toEqual([status, 409, { error: "Only an event in Planning or Needs Review can be submitted for safety review" }]);
      }
    });

    it("waits for every change request to be decided when the event is in Needs Review", async () => {
      expect(await submit(undefined, { reply: ready("Needs Review", { "change_requests.select": { count: 1 } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Decide the open change request before submitting for safety review",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "change_requests.select("id", {"count":"exact","head":true}).eq("event_id", 7).eq("status", "Pending")",
          ],
          "published": [],
          "status": 409,
        }
      `);
      expect((await submit(undefined, { reply: ready("Needs Review", { "change_requests.select": { count: 0 } }) })).status).toBe(200);
      expect((await submit(undefined, { reply: ready("Needs Review", { "change_requests.select": {} }) })).status).toBe(200);
      // a Planning event has no change requests to wait for
      expect((await submit(undefined, { reply: ready("Planning", { "change_requests.select": { count: 3 } }) })).calls.some((c) => c.startsWith("change_requests"))).toBe(false);
    });

    it("needs all four safety notes", async () => {
      expect(await submit({ safetyNotes: { crowdMovement: "x".repeat(2001) } }, { reply: ready() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Safety notes are required",
            "fields": {
              "crowdMovement": "Keep this under 2000 characters.",
              "emergencyAccess": "Describe the emergency access.",
              "equipmentPlacement": "Describe the equipment placement.",
              "venueRestrictions": "Describe any known venue restrictions, or write "None known".",
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      for (const body of [{}, { safetyNotes: null }, null]) {
        expect([body, (await submit(body, { reply: ready() })).status]).toEqual([body, 400]);
      }
    });

    it("502s when the venue or equipment services cannot be read", async () => {
      services.bookings = null;
      expect(await submit(undefined, { reply: ready() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Couldn't check this event's venue and equipment arrangements. Please try again.",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 502,
        }
      `);
      services.bookings = { bookings: [booking()] };
      services.equipment = null;
      expect((await submit(undefined, { reply: ready() })).status).toBe(502);
    });

    it("names everything still outstanding", async () => {
      services.bookings = { bookings: [booking({ status: "On Hold" })] };
      services.equipment = { equipmentRequests: [equipmentRequest(1)] };
      expect(await submit(undefined, { reply: ready() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event can't be submitted for safety review yet. Settle these first: the event has no approved venue booking; Seminar Room 3-01 is still On Hold; PA system: 1 of 2 reserved.",
            "outstanding": {
              "bookings": [
                {
                  "bookingId": 32,
                  "status": "On Hold",
                  "venueName": "Seminar Room 3-01",
                },
              ],
              "equipment": [
                {
                  "equipmentType": "PA system",
                  "quantity": 2,
                  "quantityReserved": 1,
                  "requestId": 5,
                },
              ],
              "equipmentNotArranged": null,
              "noApprovedVenue": true,
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
      services.bookings = { bookings: [] };
      services.equipment = { equipmentRequests: [] };
      expect(await submit(undefined, { reply: ready() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event can't be submitted for safety review yet. Settle these first: the event has no approved venue booking; the requested equipment (Projector) hasn't been arranged yet.",
            "outstanding": {
              "bookings": [],
              "equipment": [],
              "equipmentNotArranged": "Projector",
              "noApprovedVenue": true,
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });

    it("reads the organiser's equipment text only when it is text", async () => {
      services.equipment = { equipmentRequests: [] };
      expect((await submit(undefined, { reply: ready("Planning", {}, { submitted_details: { ...details, equipment: 5 } }) })).status).toBe(200);
      expect((await submit(undefined, { reply: ready("Planning", {}, { submitted_details: { ...details, equipment: "None required" } }) })).status).toBe(200);
      expect((await submit(undefined, { reply: ready("Planning", {}, { submitted_details: null }) })).status).toBe(200);
      expect((await submit(undefined, { reply: ready("Planning", {}) })).status).toBe(409);
    });

    it("submits with the trimmed notes, reloads the event and tells the Safety Officers and the organiser", async () => {
      expect(await submit(undefined, { reply: ready() })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "organiser_id": "ORG-1",
              "status": "Safety Review",
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
            "submissionId": 88,
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "rpc.submit_event_for_safety_review({"p_event_id":7,"p_submitted_by":"COORD-1","p_equipment_placement":"Near the stage","p_crowd_movement":"Two lanes","p_emergency_access":"Exit A","p_venue_restrictions":"None known"})",
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("id", 7).single()",
          ],
          "published": [
            {
              "actorId": "COORD-1",
              "data": {
                "eventName": "Film Night",
              },
              "eventId": 7,
              "recipients": {
                "roles": [
                  "safety_officer",
                ],
                "userIds": [
                  "ORG-1",
                ],
              },
              "type": "safety.submitted",
            },
          ],
          "status": 200,
        }
      `);
      expect(fetched).toEqual([
        ["http://localhost:4003/api/venues/events/7/bookings", "Bearer coord-token"],
        ["http://localhost:4005/api/equipment-requests?eventId=7", "Bearer coord-token"],
      ]);
    });

    it("tells no one when the event has no organiser", async () => {
      const outcome = await submit(undefined, { reply: ready("Planning", {}, { organiser_id: null }) });
      expect([outcome.status, outcome.published]).toEqual([200, []]);
    });

    it("answers 500 when the function fails, 409 when the event moved on, and 500 when the reload fails", async () => {
      expect(await submit(undefined, { reply: ready("Planning", { "rpc.submit_event_for_safety_review": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to submit the event for safety review",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "rpc.submit_event_for_safety_review({"p_event_id":7,"p_submitted_by":"COORD-1","p_equipment_placement":"Near the stage","p_crowd_movement":"Two lanes","p_emergency_access":"Exit A","p_venue_restrictions":"None known"})",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await submit(undefined, { reply: ready("Planning", { "rpc.submit_event_for_safety_review": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event is no longer in Planning or Needs Review, or no longer assigned to you",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "rpc.submit_event_for_safety_review({"p_event_id":7,"p_submitted_by":"COORD-1","p_equipment_placement":"Near the stage","p_crowd_movement":"Two lanes","p_emergency_access":"Exit A","p_venue_restrictions":"None known"})",
          ],
          "published": [],
          "status": 409,
        }
      `);
      const reloadFails = ready("Planning", { "events.select": eventsReply(row("Planning"), { error: { message: "x" } }) });
      expect(await submit(undefined, { reply: reloadFails })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Submitted for safety review, but failed to reload the event",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id, submitted_details").eq("id", 7).maybeSingle()",
            "rpc.submit_event_for_safety_review({"p_event_id":7,"p_submitted_by":"COORD-1","p_equipment_placement":"Near the stage","p_crowd_movement":"Two lanes","p_emergency_access":"Exit A","p_venue_restrictions":"None known"})",
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("id", 7).single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("the Safety Officer's gate", () => {
    const decide = (action: string, body: unknown = {}, options: Parameters<typeof send>[2] = {}) =>
      send("post", `/api/events/7/safety-review/${action}`, { user: officer, body, authorization: "Bearer so-token", ...options });
    const inReview = (extra: Responder = {}, overrides: Record<string, unknown> = {}, status = "Safety Review"): Responder => ({
      "events.select": eventsReply(row(status, overrides), { data: { id: 7, status: "Confirmed", submitted_details: { name: "Film Night" } } }),
      "rpc.approve_event_safety_review": { data: 41 },
      "rpc.reject_event_safety_review": { data: 42 },
      "rpc.request_event_safety_changes": { data: 43 },
      ...extra,
    });

    it("turns away a caller with no user or no client", async () => {
      expect(await decide("approve", {}, { user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect(await decide("reject", {}, { noClient: true })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
    });

    it("is for the Safety Officer only", async () => {
      expect(await decide("approve", {}, { user: coordinator, reply: inReview() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Only the Safety Officer can decide an Operational Safety Check",
          },
          "calls": [],
          "published": [],
          "status": 403,
        }
      `);
      for (const role of ["organiser", "coordinator_lead", "attendee"]) {
        expect([role, (await decide("reject", {}, { user: { id: "X-1", role }, reply: inReview() })).status]).toEqual([role, 403]);
      }
    });

    it("404s a malformed or unknown event and 500s a failed lookup", async () => {
      expect(await send("post", "/api/events/abc/safety-review/approve", { user: officer })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [],
          "published": [],
          "status": 404,
        }
      `);
      expect(await decide("approve", {}, { reply: {} })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 404,
        }
      `);
      expect(await decide("approve", {}, { reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load event",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("only acts on an event in Safety Review, with a message that fits the action", async () => {
      const messages = {
        approve: "Only an event in Safety Review can be approved",
        reject: "Only an event in Safety Review can be rejected",
        "request-changes": "Changes can only be requested for an event in Safety Review",
      };
      for (const [action, message] of Object.entries(messages)) {
        for (const status of ["Planning", "Confirmed", "Needs Review", "Completed"]) {
          const outcome = await decide(action, { reason: "x" }, { reply: inReview({}, {}, status) });
          expect([action, status, outcome.status, outcome.body]).toEqual([action, status, 409, { error: message }]);
        }
      }
    });
  });

  describe("approve", () => {
    const approve = (body: unknown = {}, options: Parameters<typeof send>[2] = {}) => send("post", "/api/events/7/safety-review/approve", { user: officer, body, ...options });
    const reply = (extra: Responder = {}, overrides: Record<string, unknown> = {}, reload: Reply = { data: { id: 7, status: "Confirmed", submitted_details: { name: "Film Night" } } }): Responder => ({
      "events.select": eventsReply(row("Safety Review", overrides), reload),
      "rpc.approve_event_safety_review": { data: 41 },
      ...extra,
    });

    it("approves, reloads the event and tells the coordinator and organiser", async () => {
      expect(await approve({ reason: "  All clear  " }, { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "status": "Confirmed",
              "submitted_details": {
                "name": "Film Night",
              },
            },
            "reviewId": 41,
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
            "rpc.approve_event_safety_review({"p_event_id":7,"p_officer_id":"SO-1","p_reason":"All clear"})",
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("id", 7).single()",
          ],
          "published": [
            {
              "actorId": "SO-1",
              "data": {
                "eventName": "Film Night",
                "outcome": "approved",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "COORD-1",
                  "ORG-1",
                ],
              },
              "type": "safety.decided",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("takes an optional reason: trimmed, or none", async () => {
      const reasonSent = async (body: unknown) => (await approve(body, { reply: reply() })).calls.find((c) => c.startsWith("rpc"))!;
      expect(await reasonSent({})).toContain('"p_reason":null');
      expect(await reasonSent({ reason: "   " })).toContain('"p_reason":null');
      expect(await reasonSent({ reason: 5 })).toContain('"p_reason":null');
      expect(await reasonSent({ reason: "ok" })).toContain('"p_reason":"ok"');
      const bare = await send("post", "/api/events/7/safety-review/approve", { user: officer, reply: reply() });
      expect(bare.calls.find((c) => c.startsWith("rpc"))).toContain('"p_reason":null');
    });

    it("tells only whoever is on the event, and names it only when it has a text name", async () => {
      const told = async (overrides: Record<string, unknown>, reload?: Reply) => (await approve({}, { reply: reply({}, overrides, reload) })).published[0] as any;
      expect((await told({ coordinator_id: null })).recipients.userIds).toEqual(["ORG-1"]);
      expect((await told({ organiser_id: null })).recipients.userIds).toEqual(["COORD-1"]);
      expect((await told({ coordinator_id: null, organiser_id: null })).recipients.userIds).toEqual([]);
      expect((await told({}, { data: { id: 7, submitted_details: { name: 5 } } })).data.eventName).toBeNull();
      expect((await told({}, { data: { id: 7, submitted_details: null } })).data.eventName).toBeNull();
      expect((await told({}, { data: { id: 7, submitted_details: { name: "Gala" } } })).data.eventName).toBe("Gala");
    });

    it("answers 500 when the function fails, 409 when the event moved on, and 500 when the reload fails", async () => {
      expect(await approve({}, { reply: reply({ "rpc.approve_event_safety_review": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to approve the safety review",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
            "rpc.approve_event_safety_review({"p_event_id":7,"p_officer_id":"SO-1","p_reason":null})",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await approve({}, { reply: reply({ "rpc.approve_event_safety_review": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event is no longer in Safety Review",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
            "rpc.approve_event_safety_review({"p_event_id":7,"p_officer_id":"SO-1","p_reason":null})",
          ],
          "published": [],
          "status": 409,
        }
      `);
      expect(await approve({}, { reply: reply({}, {}, { error: { message: "x" } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Approved, but failed to reload the event",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
            "rpc.approve_event_safety_review({"p_event_id":7,"p_officer_id":"SO-1","p_reason":null})",
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("id", 7).single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("reject", () => {
    const reject = (body: unknown = { reason: "Exits blocked" }, options: Parameters<typeof send>[2] = {}) => send("post", "/api/events/7/safety-review/reject", { user: officer, body, ...options });
    const reply = (extra: Responder = {}, overrides: Record<string, unknown> = {}, reload: Reply = { data: { id: 7, status: "Planning", submitted_details: { name: "Film Night" } } }): Responder => ({
      "events.select": eventsReply(row("Safety Review", overrides), reload),
      "rpc.reject_event_safety_review": { data: 42 },
      ...extra,
    });

    it("needs a reason of at most 2000 characters", async () => {
      expect(await reject({}, { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "A reason is required to reject a safety review",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      for (const body of [{ reason: "   " }, { reason: 5 }, { reason: null }]) {
        expect([body, (await reject(body, { reply: reply() })).status]).toEqual([body, 400]);
      }
      expect((await send("post", "/api/events/7/safety-review/reject", { user: officer, reply: reply() })).status).toBe(400);
      expect(await reject({ reason: "x".repeat(2001) }, { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Keep the reason under 2000 characters",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      expect((await reject({ reason: "x".repeat(2000) }, { reply: reply() })).status).toBe(200);
      expect((await reject({ reason: " ".repeat(5) + "x".repeat(2000) + " ".repeat(5) }, { reply: reply() })).status).toBe(200);
    });

    it("rejects with the trimmed reason and tells the coordinator", async () => {
      expect(await reject({ reason: "  Exits blocked  " }, { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "status": "Planning",
              "submitted_details": {
                "name": "Film Night",
              },
            },
            "reviewId": 42,
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
            "rpc.reject_event_safety_review({"p_event_id":7,"p_officer_id":"SO-1","p_reason":"Exits blocked"})",
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("id", 7).single()",
          ],
          "published": [
            {
              "actorId": "SO-1",
              "data": {
                "eventName": "Film Night",
                "outcome": "rejected",
                "reason": "Exits blocked",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "COORD-1",
                ],
              },
              "type": "safety.decided",
            },
          ],
          "status": 200,
        }
      `);
    });

    it("tells no one when nobody is assigned, and names the event only when it has a text name", async () => {
      expect((await reject(undefined, { reply: reply({}, { coordinator_id: null }) })).published).toEqual([]);
      expect(((await reject(undefined, { reply: reply({}, {}, { data: { id: 7, submitted_details: { name: 5 } } }) })).published[0] as any).data.eventName).toBeNull();
      expect(((await reject(undefined, { reply: reply({}, {}, { data: { id: 7, submitted_details: null } }) })).published[0] as any).data.eventName).toBeNull();
    });

    it("answers 500 when the function fails, 409 when the event moved on, and 500 when the reload fails", async () => {
      expect(await reject(undefined, { reply: reply({ "rpc.reject_event_safety_review": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to reject the safety review",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
            "rpc.reject_event_safety_review({"p_event_id":7,"p_officer_id":"SO-1","p_reason":"Exits blocked"})",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await reject(undefined, { reply: reply({ "rpc.reject_event_safety_review": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event is no longer in Safety Review",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
            "rpc.reject_event_safety_review({"p_event_id":7,"p_officer_id":"SO-1","p_reason":"Exits blocked"})",
          ],
          "published": [],
          "status": 409,
        }
      `);
      expect(await reject(undefined, { reply: reply({}, {}, { error: { message: "x" } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Rejected, but failed to reload the event",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
            "rpc.reject_event_safety_review({"p_event_id":7,"p_officer_id":"SO-1","p_reason":"Exits blocked"})",
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("id", 7).single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("request-changes", () => {
    const body = { arrangements: [{ type: "venue_booking", id: 32, note: "Exits blocked." }, { type: "equipment_item", id: 51, note: "Move it." }], generalNote: "Update the crowd plan." };
    const requestChanges = (payload: unknown = body, options: Parameters<typeof send>[2] = {}) =>
      send("post", "/api/events/7/safety-review/request-changes", { user: officer, body: payload, authorization: "Bearer so-token", ...options });
    const reply = (extra: Responder = {}, overrides: Record<string, unknown> = {}, reload: Reply = { data: { id: 7, status: "Planning", submitted_details: { name: "Film Night" } } }): Responder => ({
      "events.select": eventsReply(row("Safety Review", overrides), reload),
      "rpc.request_event_safety_changes": { data: 43 },
      ...extra,
    });

    it("needs at least one arrangement with a note", async () => {
      expect(await requestChanges({}, { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Pick what must change and say what for each",
            "fields": {
              "arrangements": "Select at least one venue booking or equipment reservation that must change.",
            },
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      expect((await requestChanges({ arrangements: [{ type: "venue_booking", id: 32, note: " " }] }, { reply: reply() })).status).toBe(400);
    });

    it("502s when the venue or equipment services cannot be read", async () => {
      services.equipment = null;
      expect(await requestChanges(undefined, { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Couldn't load this event's venue bookings and equipment. Try again.",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 502,
        }
      `);
      services.equipment = { equipmentRequests: [equipmentRequest()] };
      services.bookings = null;
      expect((await requestChanges(undefined, { reply: reply() })).status).toBe(502);
    });

    it("refuses arrangements that are not this event's current ones, naming them", async () => {
      expect(await requestChanges({ arrangements: [{ type: "venue_booking", id: 99, note: "Gone." }, { type: "equipment_item", id: 51, note: "Move it." }] }, { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Some of the selected arrangements aren't this event's current venue bookings or equipment",
            "fields": {
              "arrangements": "Pick from this event's current venue bookings and equipment.",
            },
            "unknown": [
              {
                "id": 99,
                "note": "Gone.",
                "type": "venue_booking",
              },
            ],
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      services.bookings = { bookings: [booking({ status: "Withdrawn" })] };
      expect((await requestChanges({ arrangements: [{ type: "venue_booking", id: 32, note: "x" }] }, { reply: reply() })).status).toBe(400);
    });

    it("records the flags and a combined reason, and tells the coordinator", async () => {
      expect(await requestChanges(undefined, { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "status": "Planning",
              "submitted_details": {
                "name": "Film Night",
              },
            },
            "reviewId": 43,
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
            "rpc.request_event_safety_changes({"p_event_id":7,"p_officer_id":"SO-1","p_reason":"Seminar Room 3-01: Exits blocked; PA system × 2: Move it. General: Update the crowd plan.","p_general_note":"Update the crowd plan.","p_flags":[{"type":"venue_booking","id":32,"label":"Seminar Room 3-01","note":"Exits blocked.","snapshot":{"status":"Approved"}},{"type":"equipment_item","id":51,"label":"PA system × 2","note":"Move it.","snapshot":{"equipmentType":"PA system","quantity":2,"quantityFulfilled":2}}]})",
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("id", 7).single()",
          ],
          "published": [
            {
              "actorId": "SO-1",
              "data": {
                "eventName": "Film Night",
                "outcome": "changes_requested",
                "reason": "Seminar Room 3-01: Exits blocked; PA system × 2: Move it. General: Update the crowd plan.",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "COORD-1",
                ],
              },
              "type": "safety.decided",
            },
          ],
          "status": 200,
        }
      `);
      expect(fetched[0]).toEqual(["http://localhost:4003/api/venues/events/7/bookings", "Bearer so-token"]);
    });

    it("tells no one when nobody is assigned, and names the event only when it has a text name", async () => {
      expect((await requestChanges(undefined, { reply: reply({}, { coordinator_id: null }) })).published).toEqual([]);
      expect(((await requestChanges(undefined, { reply: reply({}, {}, { data: { id: 7, submitted_details: { name: 5 } } }) })).published[0] as any).data.eventName).toBeNull();
      expect(((await requestChanges(undefined, { reply: reply({}, {}, { data: { id: 7, submitted_details: null } }) })).published[0] as any).data.eventName).toBeNull();
    });

    it("answers 500 when the function fails, 409 when the event moved on, and 500 when the reload fails", async () => {
      expect(await requestChanges(undefined, { reply: reply({ "rpc.request_event_safety_changes": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to request changes",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
            "rpc.request_event_safety_changes({"p_event_id":7,"p_officer_id":"SO-1","p_reason":"Seminar Room 3-01: Exits blocked; PA system × 2: Move it. General: Update the crowd plan.","p_general_note":"Update the crowd plan.","p_flags":[{"type":"venue_booking","id":32,"label":"Seminar Room 3-01","note":"Exits blocked.","snapshot":{"status":"Approved"}},{"type":"equipment_item","id":51,"label":"PA system × 2","note":"Move it.","snapshot":{"equipmentType":"PA system","quantity":2,"quantityFulfilled":2}}]})",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await requestChanges(undefined, { reply: reply({ "rpc.request_event_safety_changes": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event is no longer in Safety Review",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
            "rpc.request_event_safety_changes({"p_event_id":7,"p_officer_id":"SO-1","p_reason":"Seminar Room 3-01: Exits blocked; PA system × 2: Move it. General: Update the crowd plan.","p_general_note":"Update the crowd plan.","p_flags":[{"type":"venue_booking","id":32,"label":"Seminar Room 3-01","note":"Exits blocked.","snapshot":{"status":"Approved"}},{"type":"equipment_item","id":51,"label":"PA system × 2","note":"Move it.","snapshot":{"equipmentType":"PA system","quantity":2,"quantityFulfilled":2}}]})",
          ],
          "published": [],
          "status": 409,
        }
      `);
      expect(await requestChanges(undefined, { reply: reply({}, {}, { error: { message: "x" } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Changes requested, but failed to reload the event",
          },
          "calls": [
            "events.select("id, status, coordinator_id, organiser_id").eq("id", 7).maybeSingle()",
            "rpc.request_event_safety_changes({"p_event_id":7,"p_officer_id":"SO-1","p_reason":"Seminar Room 3-01: Exits blocked; PA system × 2: Move it. General: Update the crowd plan.","p_general_note":"Update the crowd plan.","p_flags":[{"type":"venue_booking","id":32,"label":"Seminar Room 3-01","note":"Exits blocked.","snapshot":{"status":"Approved"}},{"type":"equipment_item","id":51,"label":"PA system × 2","note":"Move it.","snapshot":{"equipmentType":"PA system","quantity":2,"quantityFulfilled":2}}]})",
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("id", 7).single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// GET /:id, GET /:id/safety-reviews, GET /:id/safety-changes  (E1-10, E3-12..14)
// ---------------------------------------------------------------------------------------------

describe("reading one event and its safety decisions", () => {
  const lead = { id: "LEAD-1", role: "coordinator_lead" };
  const officer = { id: "SO-1", role: "safety_officer" };
  const stranger = { id: "ORG-2", role: "organiser" };
  const otherCoordinator = { id: "COORD-2", role: "coordinator" };
  const fetched: [string, unknown][] = [];
  let services: { bookings: unknown; equipment: unknown };
  beforeEach(() => {
    fetched.length = 0;
    services = {
      bookings: { bookings: [{ id: 32, status: "Approved", venue: { id: 1, name: "Seminar Room 3-01" } }] },
      equipment: { equipmentRequests: [] },
    };
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      fetched.push([url, init.headers.Authorization]);
      const body = url.includes("equipment-requests") ? services.equipment : services.bookings;
      return body === null ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => body };
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("GET /:id", () => {
    const open = (options: Parameters<typeof send>[2] = {}) => send("get", "/api/events/7", options);
    const visible = (status = "Planning", extra: Responder = {}, overrides: Record<string, unknown> = {}): Responder => ({
      "events.select": { data: eventRow({ status, ...overrides }) },
      ...extra,
    });

    it("turns away a caller with no user or no client", async () => {
      expect(await open({ user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect(await open({ noClient: true })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
    });

    it("answers 403, not 404, for a malformed id, and records it", async () => {
      expect(await send("get", "/api/events/abc")).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "access_denials.insert({"user_id":"ORG-1","event_id":"abc","reason":"invalid_id_format"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
    });

    it("500s a failed lookup", async () => {
      expect(await open({ reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load event",
          },
          "calls": [
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("shows the owner, any coordinator and the Lead the event, and nobody else", async () => {
      expect(await open({ reply: visible() })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "coordinator_id": "COORD-1",
              "id": 7,
              "organiser_id": "ORG-1",
              "status": "Planning",
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 200,
        }
      `);
      for (const [who, user] of [["coordinator", otherCoordinator], ["lead", lead]] as const) {
        expect([who, (await open({ user, reply: visible() })).status]).toEqual([who, 200]);
      }
      expect(await open({ user: stranger, reply: visible() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
            "access_denials.insert({"user_id":"ORG-2","event_id":"7","reason":"not_found_or_not_owner"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
      expect((await open({ user: { id: "X-1", role: "attendee" }, reply: visible() })).status).toBe(403);
      expect(await open({ reply: {} })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
            "access_denials.insert({"user_id":"ORG-1","event_id":"7","reason":"not_found_or_not_owner"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
    });

    it("keeps a draft to its owner", async () => {
      expect((await open({ reply: visible("Draft") })).status).toBe(200);
      expect((await open({ user: coordinator, reply: visible("Draft") })).status).toBe(403);
      expect((await open({ user: lead, reply: visible("Draft") })).status).toBe(403);
    });

    it("shows a Safety Officer only an event that has been submitted for safety review", async () => {
      const submitted = visible("Safety Review", { "event_safety_submissions.select": { data: { id: 1 } } });
      const outcome = await open({ user: officer, reply: submitted });
      expect(outcome).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "coordinator_id": "COORD-1",
              "id": 7,
              "organiser_id": "ORG-1",
              "status": "Safety Review",
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override, organiser_id").eq("id", 7).maybeSingle()",
            "event_safety_submissions.select("id").eq("event_id", 7).limit(1).maybeSingle()",
          ],
          "published": [],
          "status": 200,
        }
      `);
      expect((await open({ user: officer, reply: visible("Planning") })).status).toBe(403);
      // the check is only made for a Safety Officer, and only for an event that exists
      expect((await open({ reply: submitted })).calls.some((c) => c.startsWith("event_safety_submissions"))).toBe(false);
      expect((await open({ user: officer, reply: { "event_safety_submissions.select": { data: { id: 1 } } } })).calls.some((c) => c.startsWith("event_safety_submissions"))).toBe(false);
      expect((await open({ user: { id: "X-1", role: "attendee" }, reply: submitted })).status).toBe(403);
    });
  });

  describe("GET /:id/safety-reviews", () => {
    const list = (options: Parameters<typeof send>[2] = {}) => send("get", "/api/events/7/safety-reviews", options);
    const reply = (extra: Responder = {}): Responder => ({
      "events.select": { data: eventRow({ status: "Planning" }) },
      "event_safety_reviews.select": { data: [{ id: 1, outcome: "Rejected", reason: "Exits", submission_id: 3, officer: { name: "Sam" }, created_at: "2026-01-01" }] },
      ...extra,
    });

    it("lists the decisions oldest first", async () => {
      expect(await list({ reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "safetyReviews": [
              {
                "created_at": "2026-01-01",
                "id": 1,
                "officer": {
                  "name": "Sam",
                },
                "outcome": "Rejected",
                "reason": "Exits",
                "submission_id": 3,
              },
            ],
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "event_safety_reviews.select("id, outcome, reason, submission_id, officer:officer_id(name), created_at").eq("event_id", 7).order("created_at", {"ascending":true})",
          ],
          "published": [],
          "status": 200,
        }
      `);
      expect((await list({ reply: reply({ "event_safety_reviews.select": {} }) })).body).toEqual({ safetyReviews: [] });
    });

    it("500s when they cannot be read", async () => {
      expect(await list({ reply: reply({ "event_safety_reviews.select": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load safety reviews",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "event_safety_reviews.select("id, outcome, reason, submission_id, officer:officer_id(name), created_at").eq("event_id", 7).order("created_at", {"ascending":true})",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("GET /:id/safety-changes", () => {
    const changes = (options: Parameters<typeof send>[2] = {}) => send("get", "/api/events/7/safety-changes", { user: coordinator, authorization: "Bearer coord-token", ...options });
    const review = (overrides: Record<string, unknown> = {}) => ({
      id: 40,
      outcome: "Changes Requested",
      reason: "Exits blocked",
      general_note: "Soon",
      created_at: "2026-01-01T00:00:00.000Z",
      officer: { name: "Sam" },
      ...overrides,
    });
    const flag = (overrides: Record<string, unknown> = {}) => ({
      id: 1,
      arrangement_type: "venue_booking",
      arrangement_id: 32,
      label: "Seminar Room 3-01",
      note: "Exits blocked.",
      snapshot: { status: "Approved" },
      cleared_at: null,
      ...overrides,
    });
    const reply = (extra: Responder = {}): Responder => ({
      "events.select": { data: { id: 7 } },
      "event_safety_reviews.select": { data: review() },
      "event_safety_review_flags.select": { data: [flag()] },
      ...extra,
    });

    it("turns away a caller with no user or no client", async () => {
      expect(await changes({ user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect(await changes({ noClient: true })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
    });

    it("is for coordinators, the Lead and Safety Officers only", async () => {
      expect(await changes({ user: stranger, reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [],
          "published": [],
          "status": 403,
        }
      `);
      for (const role of ["attendee", "venue_staff", "technical_support"]) {
        expect([role, (await changes({ user: { id: "X-1", role }, reply: reply() })).status]).toEqual([role, 403]);
      }
      for (const [who, user] of [["coordinator", coordinator], ["lead", lead], ["officer", officer]] as const) {
        expect([who, (await changes({ user, reply: reply() })).status]).toEqual([who, 200]);
      }
    });

    it("404s a malformed or unknown event and 500s a failed lookup", async () => {
      expect(await send("get", "/api/events/abc/safety-changes", { user: coordinator })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [],
          "published": [],
          "status": 404,
        }
      `);
      expect(await changes({ reply: reply({ "events.select": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [
            "events.select("id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 404,
        }
      `);
      expect(await changes({ reply: reply({ "events.select": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load event",
          },
          "calls": [
            "events.select("id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("500s when the decision or its flags cannot be read", async () => {
      expect(await changes({ reply: reply({ "event_safety_reviews.select": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load the requested safety changes",
          },
          "calls": [
            "events.select("id").eq("id", 7).maybeSingle()",
            "event_safety_reviews.select("id, outcome, reason, general_note, created_at, officer:officer_id(name)").eq("event_id", 7).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await changes({ reply: reply({ "event_safety_review_flags.select": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load the requested safety changes",
          },
          "calls": [
            "events.select("id").eq("id", 7).maybeSingle()",
            "event_safety_reviews.select("id, outcome, reason, general_note, created_at, officer:officer_id(name)").eq("event_id", 7).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
            "event_safety_review_flags.select("id, arrangement_type, arrangement_id, label, note, snapshot, cleared_at").eq("review_id", 40).order("id")",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("has no open request unless the latest decision asked for changes", async () => {
      expect((await changes({ reply: reply({ "event_safety_reviews.select": { data: null } }) })).body).toEqual({ changeRequest: null });
      expect((await changes({ reply: reply({ "event_safety_reviews.select": { data: review({ outcome: "Rejected" }) } }) })).body).toEqual({ changeRequest: null });
    });

    it("shows the officer's request with its flags, left as stored when nothing changed", async () => {
      expect(await changes({ reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "changeRequest": {
              "arrangementsChecked": true,
              "flags": [
                {
                  "clearedAt": null,
                  "id": 32,
                  "label": "Seminar Room 3-01",
                  "note": "Exits blocked.",
                  "type": "venue_booking",
                },
              ],
              "generalNote": "Soon",
              "officerName": "Sam",
              "reason": "Exits blocked",
              "requestedAt": "2026-01-01T00:00:00.000Z",
              "reviewId": 40,
            },
          },
          "calls": [
            "events.select("id").eq("id", 7).maybeSingle()",
            "event_safety_reviews.select("id, outcome, reason, general_note, created_at, officer:officer_id(name)").eq("event_id", 7).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
            "event_safety_review_flags.select("id, arrangement_type, arrangement_id, label, note, snapshot, cleared_at").eq("review_id", 40).order("id")",
          ],
          "published": [],
          "status": 200,
        }
      `);
      expect(fetched).toEqual([
        ["http://localhost:4003/api/venues/events/7/bookings", "Bearer coord-token"],
        ["http://localhost:4005/api/equipment-requests?eventId=7", "Bearer coord-token"],
      ]);
    });

    it("reads the officer's name from a list or from nothing, and a missing reason as empty", async () => {
      const name = async (officer: unknown) => ((await changes({ reply: reply({ "event_safety_reviews.select": { data: review({ officer }) } }) })).body as any).changeRequest.officerName;
      expect(await name([{ name: "Sam" }])).toBe("Sam");
      expect(await name([])).toBeNull();
      expect(await name(null)).toBeNull();
      expect(await name({})).toBeNull();
      const bare = await changes({ reply: reply({ "event_safety_reviews.select": { data: review({ reason: null, general_note: null }) } }) });
      expect((bare.body as any).changeRequest).toMatchObject({ reason: "", generalNote: null });
    });

    it("clears for good the flag whose arrangement changed, and only that one", async () => {
      services.bookings = { bookings: [{ id: 32, status: "Withdrawn", venue: { id: 1, name: "Seminar Room 3-01" } }] };
      const outcome = await changes({
        reply: reply({ "event_safety_review_flags.select": { data: [flag(), flag({ id: 2, arrangement_id: 33, snapshot: { status: "Approved" }, cleared_at: "2025-12-01T00:00:00.000Z" })] } }),
      });
      expect(outcome).toMatchInlineSnapshot(`
        {
          "body": {
            "changeRequest": {
              "arrangementsChecked": true,
              "flags": [
                {
                  "clearedAt": "2026-01-01T00:00:00.000Z",
                  "id": 32,
                  "label": "Seminar Room 3-01",
                  "note": "Exits blocked.",
                  "type": "venue_booking",
                },
                {
                  "clearedAt": "2025-12-01T00:00:00.000Z",
                  "id": 33,
                  "label": "Seminar Room 3-01",
                  "note": "Exits blocked.",
                  "type": "venue_booking",
                },
              ],
              "generalNote": "Soon",
              "officerName": "Sam",
              "reason": "Exits blocked",
              "requestedAt": "2026-01-01T00:00:00.000Z",
              "reviewId": 40,
            },
          },
          "calls": [
            "events.select("id").eq("id", 7).maybeSingle()",
            "event_safety_reviews.select("id, outcome, reason, general_note, created_at, officer:officer_id(name)").eq("event_id", 7).order("created_at", {"ascending":false}).limit(1).maybeSingle()",
            "event_safety_review_flags.select("id, arrangement_type, arrangement_id, label, note, snapshot, cleared_at").eq("review_id", 40).order("id")",
            "event_safety_review_flags.update({"cleared_at":"2026-01-01T00:00:00.000Z"}).in("id", [1]).is("cleared_at", null)",
          ],
          "published": [],
          "status": 200,
        }
      `);
    });

    it("shows a flag as open when clearing it fails", async () => {
      services.bookings = { bookings: [{ id: 32, status: "Withdrawn", venue: { id: 1, name: "Seminar Room 3-01" } }] };
      const outcome = await changes({ reply: reply({ "event_safety_review_flags.update": { error: { message: "x" } } }) });
      expect(outcome.status).toBe(200);
      expect((outcome.body as any).changeRequest.flags[0].clearedAt).toBeNull();
    });

    it("returns the flags as stored, unchecked, when the arrangements cannot be read", async () => {
      services.bookings = null;
      const outcome = await changes({ reply: reply() });
      expect((outcome.body as any).changeRequest).toMatchObject({ arrangementsChecked: false });
      expect(outcome.calls.some((c) => c.startsWith("event_safety_review_flags.update"))).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Creating and drafting events, deleting a draft, cancelling  (E2-1, E2-4, E2-5.2, E3-6)
// ---------------------------------------------------------------------------------------------

describe("creating, drafting and cancelling events", () => {
  const lead = { id: "LEAD-1", role: "coordinator_lead" };
  const attendee = { id: "ATT-1", role: "attendee" };
  const row = (status: string, overrides: Record<string, unknown> = {}) => eventRow({ status, ...overrides });
  const mine = (status: string, extra: Responder = {}, overrides: Record<string, unknown> = {}): Responder => ({
    "events.select": { data: row(status, overrides) },
    "events.update": { data: { id: 7, status, submitted_details: details } },
    ...extra,
  });

  describe("POST / (submit a request)", () => {
    const submit = (body: unknown = details, options: Parameters<typeof send>[2] = {}) => send("post", "/api/events", { body, ...options });
    const inserted: Responder = { "events.insert": { data: { id: 7, submitted_details: details } } };

    it("turns away a caller with no user or no client", async () => {
      expect(await submit(details, { user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect(await submit(details, { noClient: true })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
    });

    it("is for organisers only, with a message for attendees and another for staff", async () => {
      expect(await submit(details, { user: attendee, reply: inserted })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Attendees cannot manage events",
          },
          "calls": [],
          "published": [],
          "status": 403,
        }
      `);
      for (const user of [coordinator, lead, { id: "SO-1", role: "safety_officer" }]) {
        const outcome = await submit(details, { user, reply: inserted });
        expect([user.role, outcome.status, outcome.body]).toEqual([user.role, 403, { error: "Only organisers can submit event requests" }]);
      }
    });

    it("validates the request like the form does", async () => {
      expect(await submit({}, { reply: inserted })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Validation failed",
            "fields": {
              "accessibility": "This field is required.",
              "description": "This field is required.",
              "endTime": "This field is required.",
              "equipment": "This field is required.",
              "expectedAttendance": "This field is required.",
              "name": "This field is required.",
              "proposedDate": "This field is required.",
              "purpose": "This field is required.",
              "startTime": "This field is required.",
              "technicalSupport": "This field is required.",
              "venue": "This field is required.",
            },
          },
          "calls": [],
          "published": [],
          "status": 400,
        }
      `);
      expect((await send("post", "/api/events", { reply: inserted })).status).toBe(400);
    });

    it("lands in the unassigned queue, owned by the caller, and notifies the Leads and the organiser", async () => {
      expect(await submit(details, { reply: inserted })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
            "message": "Your event request has been submitted.",
          },
          "calls": [
            "events.insert({"organiser_id":"ORG-1","status":"Unassigned","coordinator_id":null,"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [
            {
              "actorId": "ORG-1",
              "data": {
                "eventName": "Film Night",
                "organiserId": "ORG-1",
              },
              "eventId": 7,
              "recipients": {
                "roles": [
                  "coordinator_lead",
                ],
                "userIds": [
                  "ORG-1",
                ],
              },
              "type": "request.submitted",
            },
          ],
          "status": 201,
        }
      `);
    });

    it("500s when it cannot be saved", async () => {
      expect(await submit(details, { reply: { "events.insert": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to submit event request",
          },
          "calls": [
            "events.insert({"organiser_id":"ORG-1","status":"Unassigned","coordinator_id":null,"submitted_details":{"name":"Film Night","purpose":"Social","description":"Movies","proposedDate":"2099-06-01","startTime":"10:00","endTime":"12:00","expectedAttendance":30,"venue":"Hall","accessibility":"Ramp","equipment":"Projector","technicalSupport":"Tech","registrationNeeded":true}}).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("POST /draft", () => {
    const save = (body: unknown = { name: "  Half done  " }, options: Parameters<typeof send>[2] = {}) => send("post", "/api/events/draft", { body, ...options });
    const inserted: Responder = { "events.insert": { data: { id: 7, status: "Draft" } } };

    it("turns away a caller with no user or no client, and attendees", async () => {
      expect(await save({}, { user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect((await save({}, { noClient: true })).status).toBe(401);
      expect(await save({}, { user: attendee, reply: inserted })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Attendees cannot manage events",
          },
          "calls": [],
          "published": [],
          "status": 403,
        }
      `);
    });

    it("saves whatever was filled in as a Draft owned by the caller, without validating", async () => {
      expect(await save(undefined, { reply: inserted })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "status": "Draft",
            },
          },
          "calls": [
            "events.insert({"organiser_id":"ORG-1","status":"Draft","submitted_details":{"name":"Half done","purpose":"","description":"","proposedDate":"","startTime":"","endTime":"","expectedAttendance":null,"venue":"","accessibility":"","equipment":"","technicalSupport":"","registrationNeeded":false}}).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [],
          "status": 201,
        }
      `);
      expect((await save({}, { reply: inserted })).status).toBe(201);
      expect((await send("post", "/api/events/draft", { reply: inserted })).status).toBe(201);
    });

    it("500s when it cannot be saved", async () => {
      expect(await save(undefined, { reply: { "events.insert": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to save draft",
          },
          "calls": [
            "events.insert({"organiser_id":"ORG-1","status":"Draft","submitted_details":{"name":"Half done","purpose":"","description":"","proposedDate":"","startTime":"","endTime":"","expectedAttendance":null,"venue":"","accessibility":"","equipment":"","technicalSupport":"","registrationNeeded":false}}).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("PATCH /:id/draft and DELETE /:id/draft", () => {
    const patchDraft = (options: Parameters<typeof send>[2] = {}) => send("patch", "/api/events/7/draft", { body: { name: "  Better  " }, ...options });
    const deleteDraft = (options: Parameters<typeof send>[2] = {}) => send("delete", "/api/events/7/draft", options);

    it("turns away a caller with no user or no client", async () => {
      expect(await patchDraft({ user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect(await deleteDraft({ noClient: true })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
    });

    it("404s a malformed id and 500s a failed lookup", async () => {
      expect(await send("patch", "/api/events/abc/draft", { body: {} })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [],
          "published": [],
          "status": 404,
        }
      `);
      expect(await send("delete", "/api/events/abc/draft")).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [],
          "published": [],
          "status": 404,
        }
      `);
      expect(await patchDraft({ reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load draft",
          },
          "calls": [
            "events.select("id, status, organiser_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await deleteDraft({ reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load draft",
          },
          "calls": [
            "events.select("id, status, organiser_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("is for the owner only, and records anyone else's attempt (an unknown event reads the same)", async () => {
      expect(await patchDraft({ user: { id: "ORG-2", role: "organiser" }, reply: mine("Draft") })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "events.select("id, status, organiser_id").eq("id", 7).maybeSingle()",
            "access_denials.insert({"user_id":"ORG-2","event_id":"7","reason":"not_found_or_not_owner"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
      expect(await deleteDraft({ user: { id: "ORG-2", role: "organiser" }, reply: mine("Draft") })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "events.select("id, status, organiser_id").eq("id", 7).maybeSingle()",
            "access_denials.insert({"user_id":"ORG-2","event_id":"7","reason":"not_found_or_not_owner"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
      expect((await patchDraft({ reply: {} })).status).toBe(403);
      expect((await deleteDraft({ reply: {} })).status).toBe(403);
    });

    it("only while it is still a draft", async () => {
      for (const status of ["Unassigned", "Requested", "Planning", "Confirmed", "Cancelled"]) {
        for (const outcome of [await patchDraft({ reply: mine(status) }), await deleteDraft({ reply: mine(status) })]) {
          expect([status, outcome.status, outcome.body]).toEqual([status, 409, { error: "This request is no longer a draft" }]);
        }
      }
    });

    it("saves progress on a draft", async () => {
      expect(await patchDraft({ reply: mine("Draft") })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "status": "Draft",
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
          },
          "calls": [
            "events.select("id, status, organiser_id").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Better","purpose":"","description":"","proposedDate":"","startTime":"","endTime":"","expectedAttendance":null,"venue":"","accessibility":"","equipment":"","technicalSupport":"","registrationNeeded":false}}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [],
          "status": 200,
        }
      `);
      expect((await send("patch", "/api/events/7/draft", { reply: mine("Draft") })).status).toBe(200);
    });

    it("deletes a draft", async () => {
      expect(await deleteDraft({ reply: mine("Draft", { "events.delete": {} }) })).toMatchInlineSnapshot(`
        {
          "body": {},
          "calls": [
            "events.select("id, status, organiser_id").eq("id", 7).maybeSingle()",
            "events.delete().eq("id", 7)",
          ],
          "published": [],
          "status": 204,
        }
      `);
    });

    it("500s when saving or deleting fails", async () => {
      expect(await patchDraft({ reply: mine("Draft", { "events.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to save draft",
          },
          "calls": [
            "events.select("id, status, organiser_id").eq("id", 7).maybeSingle()",
            "events.update({"submitted_details":{"name":"Better","purpose":"","description":"","proposedDate":"","startTime":"","endTime":"","expectedAttendance":null,"venue":"","accessibility":"","equipment":"","technicalSupport":"","registrationNeeded":false}}).eq("id", 7).select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").single()",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await deleteDraft({ reply: mine("Draft", { "events.delete": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to delete draft",
          },
          "calls": [
            "events.select("id, status, organiser_id").eq("id", 7).maybeSingle()",
            "events.delete().eq("id", 7)",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("POST /:id/cancel", () => {
    const cancel = (body: unknown = { reason: "  Venue lost  " }, options: Parameters<typeof send>[2] = {}) => send("post", "/api/events/7/cancel", { body, ...options });

    it("turns away a caller with no user or no client", async () => {
      expect(await cancel({}, { user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect((await cancel({}, { noClient: true })).status).toBe(401);
    });

    it("404s a malformed or unknown event and 500s a failed lookup", async () => {
      expect(await send("post", "/api/events/abc/cancel", { body: {} })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [],
          "published": [],
          "status": 404,
        }
      `);
      expect(await cancel(undefined, { reply: {} })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Event not found",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 404,
        }
      `);
      expect(await cancel(undefined, { reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load event",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });

    it("is for the owner only, and records anyone else's attempt", async () => {
      expect(await cancel(undefined, { user: { id: "ORG-2", role: "organiser" }, reply: mine("Planning") })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "access_denials.insert({"user_id":"ORG-2","event_id":"7","reason":"not_found_or_not_owner"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
    });

    it("refuses a draft (delete it instead) and every closed status, naming it", async () => {
      expect(await cancel(undefined, { reply: mine("Draft") })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This is still a draft — delete it instead of cancelling it.",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
      for (const status of ["Rejected", "Completed", "Cancelled"]) {
        const outcome = await cancel(undefined, { reply: mine(status) });
        expect([status, outcome.status, outcome.body]).toEqual([status, 409, { error: `This event is ${status} and can no longer be cancelled.` }]);
      }
    });

    it("needs a reason", async () => {
      expect(await cancel({}, { reply: mine("Planning") })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "A reason is required to cancel an event",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
          ],
          "published": [],
          "status": 400,
        }
      `);
      for (const body of [{ reason: "  " }, { reason: 5 }, { reason: null }]) {
        expect([body, (await cancel(body, { reply: mine("Planning") })).status]).toEqual([body, 400]);
      }
      expect((await send("post", "/api/events/7/cancel", { reply: mine("Planning") })).status).toBe(400);
    });

    it("cancels from every active status, recording the status and the reason", async () => {
      expect(await cancel(undefined, { reply: mine("Planning") })).toMatchInlineSnapshot(`
        {
          "body": {
            "event": {
              "id": 7,
              "status": "Planning",
              "submitted_details": {
                "accessibility": "Ramp",
                "description": "Movies",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "purpose": "Social",
                "registrationNeeded": true,
                "startTime": "10:00",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            },
            "notificationsFailed": false,
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "events.update({"status":"Cancelled","review_outcome":"Venue lost","decided_at":"2026-01-01T00:00:00.000Z","decided_by":"ORG-1"}).eq("id", 7).eq("status", "Planning").select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
            "event_history.insert([{"event_id":7,"field":"Status","old_value":"Planning","new_value":"Cancelled","changed_by":"ORG-1"},{"event_id":7,"field":"Cancellation reason","old_value":null,"new_value":"Venue lost","changed_by":"ORG-1"}])",
            "event_outbox.insert({"type":"event.cancelled","event_id":7,"actor_id":"ORG-1","recipients":{"userIds":["ORG-1","COORD-1"],"roles":[]},"data":{"eventName":"Film Night","reason":"Venue lost"}}).select("id, message_id, type, event_id, actor_id, recipients, data, occurred_at").single()",
          ],
          "published": [
            {
              "actorId": "ORG-1",
              "data": {
                "eventName": "Film Night",
                "reason": "Venue lost",
              },
              "eventId": 7,
              "recipients": {
                "roles": [],
                "userIds": [
                  "ORG-1",
                  "COORD-1",
                ],
              },
              "type": "event.cancelled",
            },
          ],
          "status": 200,
        }
      `);
      for (const status of ["Unassigned", "Requested", "Clarification Requested", "Safety Review", "Confirmed", "Needs Review"]) {
        const outcome = await cancel(undefined, { reply: mine(status) });
        expect([status, outcome.status, outcome.calls[1]]).toEqual([status, 200, expect.stringContaining(`.eq("status", "${status}")`)]);
      }
    });

    it("tells every Lead when nobody is assigned, and reports a broker that did not confirm", async () => {
      const unassigned = await cancel(undefined, { reply: mine("Unassigned", {}, { coordinator_id: null }) });
      expect((unassigned.published[0] as any).recipients).toEqual({ userIds: ["ORG-1"], roles: ["coordinator_lead"] });
      expect((unassigned.body as any).notificationsFailed).toBe(false);
      const failed = await cancel(undefined, { reply: mine("Planning"), publishOk: false });
      expect([failed.status, (failed.body as any).notificationsFailed]).toEqual([200, true]);
    });

    it("answers 500 when the update fails and 409 when the event changed meanwhile", async () => {
      expect(await cancel(undefined, { reply: mine("Planning", { "events.update": { error: { message: "x" } } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to cancel this event",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "events.update({"status":"Cancelled","review_outcome":"Venue lost","decided_at":"2026-01-01T00:00:00.000Z","decided_by":"ORG-1"}).eq("id", 7).eq("status", "Planning").select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
          ],
          "published": [],
          "status": 500,
        }
      `);
      expect(await cancel(undefined, { reply: mine("Planning", { "events.update": { data: null } }) })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "This event changed while you were cancelling it. Refresh and try again.",
          },
          "calls": [
            "events.select("id, status, organiser_id, coordinator_id").eq("id", 7).maybeSingle()",
            "events.update({"status":"Cancelled","review_outcome":"Venue lost","decided_at":"2026-01-01T00:00:00.000Z","decided_by":"ORG-1"}).eq("id", 7).eq("status", "Planning").select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").maybeSingle()",
          ],
          "published": [],
          "status": 409,
        }
      `);
    });
  });

  describe("the logging helpers", () => {
    it("log when an access denial cannot be recorded, with what was being recorded", async () => {
      await send("patch", "/api/events/7/draft", { user: { id: "ORG-2", role: "organiser" }, body: {}, reply: mine("Draft", { "access_denials.insert": { error: { message: "x" } } }) });
      expect(console.error).toHaveBeenCalledWith("Failed to record access_denials row", { userId: "ORG-2", eventId: "7", reason: "not_found_or_not_owner", error: { message: "x" } });
    });

    it("say nothing when an access denial is recorded", async () => {
      await send("patch", "/api/events/7/draft", { user: { id: "ORG-2", role: "organiser" }, body: {}, reply: mine("Draft") });
      expect(console.error).not.toHaveBeenCalledWith("Failed to record access_denials row", expect.anything());
    });

    it("log when history cannot be recorded, and say nothing when it is", async () => {
      await send("post", "/api/events/7/cancel", { body: { reason: "x" }, reply: mine("Planning", { "event_history.insert": { error: { message: "x" } } }) });
      expect(console.error).toHaveBeenCalledWith("Failed to record event_history rows", { eventId: 7, changedBy: "ORG-1", error: { message: "x" } });
      vi.mocked(console.error).mockClear();
      await send("post", "/api/events/7/cancel", { body: { reason: "x" }, reply: mine("Planning") });
      expect(console.error).not.toHaveBeenCalledWith("Failed to record event_history rows", expect.anything());
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The read endpoints: GET /, /venue-booking-info, /attendee-info, /open-for-registration  (E1-5, E2-5.1, E6)
// ---------------------------------------------------------------------------------------------

describe("the event read endpoints", () => {
  const lead = { id: "LEAD-1", role: "coordinator_lead" };
  const attendee = { id: "ATT-1", role: "attendee" };
  const staff = { id: "VS-1", role: "venue_staff" };
  const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(",");

  describe("GET / (the list)", () => {
    const list = (options: Parameters<typeof send>[2] = {}) => send("get", "/api/events", options);
    const rows: Responder = { "events.select": { data: [{ id: 1 }, { id: 2 }] } };

    it("turns away a caller with no user or no client, and attendees", async () => {
      expect(await list({ user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect((await list({ noClient: true })).status).toBe(401);
      expect(await list({ user: attendee, reply: rows })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Attendees cannot manage events",
          },
          "calls": [],
          "published": [],
          "status": 403,
        }
      `);
    });

    it("shows an organiser (and any other role) only their own events, drafts included", async () => {
      expect(await list({ reply: rows })).toMatchInlineSnapshot(`
        {
          "body": {
            "events": [
              {
                "id": 1,
              },
              {
                "id": 2,
              },
            ],
          },
          "calls": [
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("organiser_id", "ORG-1")",
          ],
          "published": [],
          "status": 200,
        }
      `);
      for (const user of [staff, { id: "SO-1", role: "safety_officer" }]) {
        expect([user.role, (await list({ user, reply: rows })).calls[0]]).toEqual([user.role, expect.stringContaining('.eq("organiser_id", "' + user.id + '")')]);
      }
    });

    it("shows coordinators and the Lead every event but drafts", async () => {
      for (const user of [coordinator, lead]) {
        expect([user.role, (await list({ user, reply: rows })).calls[0]]).toEqual([user.role, expect.stringContaining('.neq("status", "Draft")')]);
      }
      expect((await list({ user: coordinator, reply: rows })).calls[0]).not.toContain("organiser_id\", ");
    });

    it("500s when the list cannot be read", async () => {
      expect(await list({ reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load events",
          },
          "calls": [
            "events.select("id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override").eq("organiser_id", "ORG-1")",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("GET /venue-booking-info", () => {
    const info = (query: string, options: Parameters<typeof send>[2] = {}) => send("get", `/api/events/venue-booking-info${query}`, { user: staff, ...options });
    const reply = (data: unknown = [{ id: 1 }]): Responder => ({ "events.select": { data } });
    const row = { id: 7, status: "Planning", coordinator_id: "COORD-1", submitted_details: { ...details, purpose: "secret", description: "secret" } };

    it("needs a database client", async () => {
      expect(await info("?ids=1", { noClient: true })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
    });

    it("lets venue staff, coordinators and technical support in, and records everyone else", async () => {
      for (const user of [staff, coordinator, { id: "TS-1", role: "technical_support" }]) {
        expect([user.role, (await info("?ids=1", { user, reply: reply() })).status]).toEqual([user.role, 200]);
      }
      expect(await info("?ids=1,2", { user: organiser, reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "access_denials.insert({"user_id":"ORG-1","event_id":"1,2","reason":"venue_booking_info_role_not_allowed"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
      // with no ids asked for, the denial records an empty id
      expect((await info("", { user: attendee, reply: reply() })).calls).toEqual([expect.stringContaining('"event_id":"","reason":"venue_booking_info_role_not_allowed"')]);
    });

    it("lets an internal caller with no user skip the role check", async () => {
      expect((await info("?ids=1", { user: null, reply: reply() })).status).toBe(200);
    });

    it("needs 1 to 100 comma-separated positive ids", async () => {
      expect(await info("", { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "ids must be 1–100 comma-separated event ids",
          },
          "calls": [],
          "published": [],
          "status": 400,
        }
      `);
      for (const query of ["?ids=", "?ids=abc", "?ids=1,,2", "?ids=1,0", "?ids=1,-2", "?ids=1&ids=2", `?ids=${ids(101)}`]) {
        expect([query, (await info(query, { reply: reply() })).status]).toEqual([query, 400]);
      }
      expect((await info(`?ids=${ids(100)}`, { reply: reply() })).status).toBe(200);
      expect((await info("?ids=%201%20,%202%20", { reply: reply() })).calls[0]).toContain('.in("id", [1,2])');
    });

    it("asks for each id once, drafts excluded, and gives only the booking-relevant fields", async () => {
      expect(await info("?ids=7,7,8", { reply: reply([row]) })).toMatchInlineSnapshot(`
        {
          "body": {
            "events": [
              {
                "accessibility": "Ramp",
                "coordinatorId": "COORD-1",
                "endTime": "12:00",
                "equipment": "Projector",
                "expectedAttendance": 30,
                "id": 7,
                "name": "Film Night",
                "proposedDate": "2099-06-01",
                "startTime": "10:00",
                "status": "Planning",
                "technicalSupport": "Tech",
                "venue": "Hall",
              },
            ],
          },
          "calls": [
            "events.select("id, status, submitted_details, coordinator_id").in("id", [7,8]).neq("status", "Draft")",
          ],
          "published": [],
          "status": 200,
        }
      `);
    });

    it("fills what is missing with null", async () => {
      const outcome = await info("?ids=7", { reply: reply([{ id: 7, status: "Planning", coordinator_id: null, submitted_details: null }]) });
      expect((outcome.body as any).events[0]).toEqual({
        id: 7, status: "Planning", coordinatorId: null, name: null, proposedDate: null, startTime: null, endTime: null,
        expectedAttendance: null, venue: null, accessibility: null, equipment: null, technicalSupport: null,
      });
      expect((await info("?ids=7", { reply: { "events.select": {} } })).body).toEqual({ events: [] });
    });

    it("500s when the events cannot be read", async () => {
      expect(await info("?ids=1", { reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load events",
          },
          "calls": [
            "events.select("id, status, submitted_details, coordinator_id").in("id", [1]).neq("status", "Draft")",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("GET /attendee-info", () => {
    const info = (query: string, options: Parameters<typeof send>[2] = {}) => send("get", `/api/events/attendee-info${query}`, { user: attendee, ...options });
    const open = { registration_open_date: "2025-12-01", registration_override: null, organiser: { name: "  Olive  " } };
    const confirmed = (overrides: Record<string, unknown> = {}, detailOverrides: Record<string, unknown> = {}) => ({
      id: 7, status: "Confirmed", ...open, ...overrides, submitted_details: { ...details, accessibility: "Step-free entrance", ...detailOverrides },
    });
    const reply = (data: unknown = [confirmed()]): Responder => ({ "events.select": { data } });

    it("turns away a caller with no user or no client", async () => {
      expect(await info("?ids=7", { user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect((await info("?ids=7", { noClient: true })).status).toBe(401);
    });

    it("is for attendees only, and records anyone else's attempt with the ids asked for", async () => {
      expect(await info("?ids=7", { user: organiser, reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "access_denials.insert({"user_id":"ORG-1","event_id":"7","reason":"attendee_info_role_not_allowed"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
      expect((await info("", { user: coordinator, reply: reply() })).calls[0]).toContain('"event_id":""');
    });

    it("needs 1 to 100 comma-separated positive ids", async () => {
      expect(await info("", { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "ids must be 1–100 comma-separated event ids",
          },
          "calls": [],
          "published": [],
          "status": 400,
        }
      `);
      for (const query of ["?ids=", "?ids=1,abc", "?ids=abc,1", "?ids=1,,2", "?ids=0", `?ids=${ids(101)}`]) {
        expect([query, (await info(query, { reply: reply() })).status]).toEqual([query, 400]);
      }
      expect((await info(`?ids=${ids(100)}`, { reply: reply() })).status).toBe(200);
      expect((await info("?ids=%207%20,%208,7", { reply: reply() })).calls[0]).toContain('.in("id", [7,8])');
    });

    it("gives attendees the whitelisted fields, the registration period and nothing private", async () => {
      expect(await info("?ids=7", { reply: reply() })).toMatchInlineSnapshot(`
        {
          "body": {
            "events": [
              {
                "accessibility": "Step-free entrance",
                "capacity": 30,
                "description": "Movies",
                "endTime": "12:00",
                "hasStarted": false,
                "id": 7,
                "listed": true,
                "name": "Film Night",
                "open": true,
                "organiserName": "Olive",
                "proposedDate": "2099-06-01",
                "registrationNeeded": true,
                "registrationState": "OPEN",
                "startTime": "10:00",
                "viewable": true,
              },
            ],
          },
          "calls": [
            "events.select("id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)").in("id", [7]).neq("status", "Draft")",
          ],
          "published": [],
          "status": 200,
        }
      `);
    });

    it("tells a registration-free event, an event with no note, no cap and no organiser name", async () => {
      const bare = await info("?ids=7", {
        reply: reply([confirmed({ organiser: null }, { registrationNeeded: false, accessibility: "None", expectedAttendance: 0 })]),
      });
      expect((bare.body as any).events[0]).toMatchObject({ registrationNeeded: false, accessibility: null, capacity: null, organiserName: null });
      const text = await info("?ids=7", { reply: reply([confirmed({}, { registrationNeeded: "yes" })]) });
      expect((text.body as any).events[0].registrationNeeded).toBe(false);
      const nothing = await info("?ids=7", { reply: reply([{ id: 7, status: "Confirmed", submitted_details: null }]) });
      expect((nothing.body as any).events[0]).toMatchObject({ name: null, proposedDate: null, accessibility: null, capacity: null, hasStarted: false });
      expect((await info("?ids=7", { reply: { "events.select": {} } })).body).toEqual({ events: [] });
    });

    it("says whether the event has started, to the minute", async () => {
      // the clock reads 2026-01-01 08:00 Singapore time
      const started = async (startTime: string) => ((await info("?ids=7", { reply: reply([confirmed({}, { proposedDate: "2026-01-01", startTime })]) })).body as any).events[0].hasStarted;
      expect(await started("08:00")).toBe(true);
      expect(await started("08:01")).toBe(false);
    });

    it("500s when the events cannot be read", async () => {
      expect(await info("?ids=7", { reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load events",
          },
          "calls": [
            "events.select("id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)").in("id", [7]).neq("status", "Draft")",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("GET /open-for-registration", () => {
    const find = (options: Parameters<typeof send>[2] = {}) => send("get", "/api/events/open-for-registration", { user: attendee, ...options });
    const event = (id: number, overrides: Record<string, unknown> = {}, detailOverrides: Record<string, unknown> = {}) => ({
      id, status: "Confirmed", registration_open_date: "2025-12-01", registration_override: null, organiser: { name: "Olive" },
      submitted_details: { ...details, accessibility: "n/a", ...detailOverrides }, ...overrides,
    });

    it("turns away a caller with no user or no client, and anyone but an attendee", async () => {
      expect(await find({ user: null })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Unauthenticated",
          },
          "calls": [],
          "published": [],
          "status": 401,
        }
      `);
      expect((await find({ noClient: true })).status).toBe(401);
      expect(await find({ user: organiser })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Access denied",
          },
          "calls": [
            "access_denials.insert({"user_id":"ORG-1","event_id":"","reason":"open_for_registration_role_not_allowed"})",
          ],
          "published": [],
          "status": 403,
        }
      `);
    });

    it("lists the Confirmed events that registration has opened for", async () => {
      const outcome = await find({
        reply: { "events.select": { data: [event(1), event(2, { registration_open_date: null }), event(3, {}, { registrationNeeded: false }), event(4, { registration_override: "FORCE_OPEN", registration_open_date: null })] } },
      });
      expect(outcome).toMatchInlineSnapshot(`
        {
          "body": {
            "events": [
              {
                "accessibility": null,
                "capacity": 30,
                "description": "Movies",
                "endTime": "12:00",
                "id": 1,
                "listed": true,
                "name": "Film Night",
                "open": true,
                "organiserName": "Olive",
                "proposedDate": "2099-06-01",
                "registrationNeeded": true,
                "registrationState": "OPEN",
                "startTime": "10:00",
                "viewable": true,
              },
              {
                "accessibility": null,
                "capacity": null,
                "description": "Movies",
                "endTime": "12:00",
                "id": 3,
                "listed": false,
                "name": "Film Night",
                "open": false,
                "organiserName": "Olive",
                "proposedDate": "2099-06-01",
                "registrationNeeded": false,
                "registrationState": "CLOSED",
                "startTime": "10:00",
                "viewable": true,
              },
              {
                "accessibility": null,
                "capacity": 30,
                "description": "Movies",
                "endTime": "12:00",
                "id": 4,
                "listed": true,
                "name": "Film Night",
                "open": true,
                "organiserName": "Olive",
                "proposedDate": "2099-06-01",
                "registrationNeeded": true,
                "registrationState": "OPEN",
                "startTime": "10:00",
                "viewable": true,
              },
            ],
          },
          "calls": [
            "events.select("id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)").eq("status", "Confirmed")",
          ],
          "published": [],
          "status": 200,
        }
      `);
    });

    it("answers an empty list when nothing is open or there is no data, and 500s a failed read", async () => {
      expect((await find({ reply: { "events.select": {} } })).body).toEqual({ events: [] });
      expect(await find({ reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
        {
          "body": {
            "error": "Failed to load events",
          },
          "calls": [
            "events.select("id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)").eq("status", "Confirmed")",
          ],
          "published": [],
          "status": 500,
        }
      `);
    });
  });

  describe("attendeeAccessibility", () => {
    it("reads a 'nothing to note' answer, and only that, as no note", () => {
      for (const text of ["NA", "n/a", "N/A.", "nil", "None", "no", "nope", "-", "-----", "not applicable", "No preference", "no requirement", "No requirements.", "not required", "Not needed", "  none  ", ""]) {
        expect([text, attendeeAccessibility(text)]).toEqual([text, null]);
      }
      for (const text of ["ramp. none", "none of the above", "needs a ramp", "nope not really", "no step-free access", "not needed at 3pm"]) {
        expect([text, attendeeAccessibility(text)]).toEqual([text, text]);
      }
      expect(attendeeAccessibility("  Step-free  ")).toBe("Step-free");
      expect(attendeeAccessibility(5)).toBeNull();
      expect(attendeeAccessibility(null)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// POST /:id/change-requests: the remaining cases  (E3-8, E3-9)
// ---------------------------------------------------------------------------------------------

describe("raising a change request: the remaining cases", () => {
  const post = (body: unknown, options: Parameters<typeof send>[2] = {}) => send("post", "/api/events/7/change-requests", { body, ...options });
  const open = (fields: unknown[], overrides: Record<string, unknown> = {}): Responder => ({
    "events.select": { data: eventRow({ status: "Needs Review", ...overrides }) },
    "change_requests.select": { data: { id: 3 } },
    "change_request_fields.select": { data: fields },
  });
  const held = (id: number, field: string, oldValue: string, newValue: string, critical = true) => ({ id, field, old_value: oldValue, new_value: newValue, is_critical: critical });

  it("ignores a stale non-critical row on the open request when working out what changed", async () => {
    const outcome = await post(
      { description: "Movies", expectedAttendance: 45 },
      { reply: open([held(1, "description", "Movies", "Stale text", false), held(2, "venue", "Hall", "Other hall")]) },
    );
    expect(outcome).toMatchInlineSnapshot(`
      {
        "body": {
          "applied": [],
          "autoResolved": false,
          "changeRequestId": 3,
          "held": [
            "expectedAttendance",
          ],
          "notificationsFailed": false,
          "reverted": [],
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_request_fields.select("id, field, old_value, new_value, is_critical").eq("request_id", 3)",
          "change_request_fields.upsert([{"request_id":3,"field":"expectedAttendance","old_value":"30","new_value":"45","is_critical":true}], {"onConflict":"request_id,field"})",
          "event_history.insert([{"event_id":7,"field":"expectedAttendance","old_value":"30","new_value":"requested: 45 (pending coordinator review)","changed_by":"ORG-1"}])",
        ],
        "published": [
          {
            "actorId": "ORG-1",
            "data": {
              "changeRequestId": 3,
              "eventName": "Film Night",
              "fields": [
                "expectedAttendance",
              ],
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "COORD-1",
              ],
            },
            "type": "change.requested",
          },
        ],
        "status": 201,
      }
    `);
  });

  it("closes a request out when two held fields are both reverted, naming each and keeping each one's own discarded value", async () => {
    const outcome = await post(
      { venue: "Hall", accessibility: "Ramp" },
      { reply: open([held(1, "venue", "Hall", "Other hall"), held(2, "accessibility", "Ramp", "Stairs")]) },
    );
    expect(outcome).toMatchInlineSnapshot(`
      {
        "body": {
          "applied": [],
          "autoResolved": true,
          "changeRequestId": 3,
          "held": [],
          "notificationsFailed": false,
          "reverted": [
            "venue",
            "accessibility",
          ],
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_request_fields.select("id, field, old_value, new_value, is_critical").eq("request_id", 3)",
          "change_request_fields.delete().eq("request_id", 3).in("field", ["venue","accessibility"])",
          "event_history.insert([{"event_id":7,"field":"venue","old_value":"Other hall","new_value":"reverted to Hall (no longer pending)","changed_by":"ORG-1"},{"event_id":7,"field":"accessibility","old_value":"Stairs","new_value":"reverted to Ramp (no longer pending)","changed_by":"ORG-1"}])",
          "change_requests.update({"status":"Auto-Withdrawn","decided_at":"2026-01-01T00:00:00.000Z","decided_by":null,"decision_reason":"The requested change to venue, accessibility was reverted before it was reviewed."}).eq("id", 3)",
        ],
        "published": [
          {
            "actorId": "ORG-1",
            "data": {
              "changeRequestId": 3,
              "eventName": "Film Night",
              "fields": [
                "venue",
                "accessibility",
              ],
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "ORG-1",
                "COORD-1",
              ],
            },
            "type": "change.withdrawn",
          },
        ],
        "status": 201,
      }
    `);
  });

  it("keeps the request open when one held field is reverted while another is newly held", async () => {
    const outcome = await post({ venue: "Hall", expectedAttendance: 45 }, { reply: open([held(1, "venue", "Hall", "Other hall")]) });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "body": {
          "applied": [],
          "autoResolved": false,
          "changeRequestId": 3,
          "held": [
            "expectedAttendance",
          ],
          "notificationsFailed": false,
          "reverted": [
            "venue",
          ],
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_request_fields.select("id, field, old_value, new_value, is_critical").eq("request_id", 3)",
          "change_request_fields.delete().eq("request_id", 3).in("field", ["venue"])",
          "change_request_fields.upsert([{"request_id":3,"field":"expectedAttendance","old_value":"30","new_value":"45","is_critical":true}], {"onConflict":"request_id,field"})",
          "event_history.insert([{"event_id":7,"field":"expectedAttendance","old_value":"30","new_value":"requested: 45 (pending coordinator review)","changed_by":"ORG-1"}])",
          "event_history.insert([{"event_id":7,"field":"venue","old_value":"Other hall","new_value":"reverted to Hall (no longer pending)","changed_by":"ORG-1"}])",
        ],
        "published": [
          {
            "actorId": "ORG-1",
            "data": {
              "changeRequestId": 3,
              "eventName": "Film Night",
              "fields": [
                "expectedAttendance",
                "venue",
              ],
            },
            "eventId": 7,
            "recipients": {
              "roles": [],
              "userIds": [
                "COORD-1",
              ],
            },
            "type": "change.requested",
          },
        ],
        "status": 201,
      }
    `);
  });

  it("applies registrationNeeded as a real boolean, whether it was sent as one or as text", async () => {
    const applied = async (committed: boolean, sent: unknown) => {
      const outcome = await post(
        { registrationNeeded: sent },
        { reply: { "events.select": { data: eventRow({ status: "Confirmed", submitted_details: { ...details, registrationNeeded: committed } }) }, "change_requests.insert": { data: { id: 9 } } } },
      );
      const update = outcome.calls.find((call) => call.startsWith("events.update"));
      return [outcome.status, update && JSON.parse(update.slice(14, update.indexOf("}).eq") + 1)).submitted_details.registrationNeeded];
    };
    expect(await applied(false, true)).toEqual([201, true]);
    expect(await applied(false, "true")).toEqual([201, true]);
    expect(await applied(true, false)).toEqual([201, false]);
    expect(await applied(true, "false")).toEqual([201, false]);
  });

  it("refuses to blank a required field, even one the event never had", async () => {
    const withoutAccessibility = { ...details } as Record<string, unknown>;
    delete withoutAccessibility.accessibility;
    const outcome = await post(
      { accessibility: "" },
      { reply: open([held(1, "accessibility", "", "Stairs")], { submitted_details: withoutAccessibility }) },
    );
    expect(outcome).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Validation failed",
          "fields": {
            "accessibility": "This field is required.",
          },
        },
        "calls": [
          "events.select("id, status, organiser_id, coordinator_id, submitted_details").eq("id", 7).maybeSingle()",
          "change_requests.select("id").eq("event_id", 7).eq("status", "Pending").maybeSingle()",
          "change_request_fields.select("id, field, old_value, new_value, is_critical").eq("request_id", 3)",
        ],
        "published": [],
        "status": 400,
      }
    `);
  });
});

// ---------------------------------------------------------------------------------------------
// GET /public and /public/:id (guests, no login)  (E6)
// ---------------------------------------------------------------------------------------------

describe("public events", () => {
  const list = (options: Parameters<typeof send>[2] = {}) => send("get", "/api/events/public", { user: null, ...options });
  const one = (id: string, options: Parameters<typeof send>[2] = {}) => send("get", `/api/events/public/${id}`, { user: null, ...options });
  const event = (id: number, overrides: Record<string, unknown> = {}, detailOverrides: Record<string, unknown> = {}) => ({
    id, status: "Confirmed", registration_open_date: "2025-12-01", registration_override: null, organiser: { name: "  Olive  " },
    submitted_details: { ...details, accessibility: "Step-free entrance", purpose: "private", description: "Movies", ...detailOverrides }, ...overrides,
  });

  it("lists the Confirmed events that registration has opened for, with the guest whitelist only", async () => {
    const outcome = await list({
      reply: { "events.select": { data: [event(1), event(2, { registration_open_date: null }), event(3, {}, { registrationNeeded: false })] } },
    });
    expect(outcome).toMatchInlineSnapshot(`
      {
        "body": {
          "events": [
            {
              "accessibility": "Step-free entrance",
              "description": "Movies",
              "endTime": "12:00",
              "id": 1,
              "name": "Film Night",
              "open": true,
              "organiserName": "Olive",
              "proposedDate": "2099-06-01",
              "registrationState": "OPEN",
              "startTime": "10:00",
            },
          ],
        },
        "calls": [
          "events.select("id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)").eq("status", "Confirmed")",
        ],
        "published": [],
        "status": 200,
      }
    `);
  });

  it("lists nothing when there is no data, and 500s a failed read", async () => {
    expect((await list({ reply: { "events.select": {} } })).body).toEqual({ events: [] });
    expect(await list({ reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to load events",
        },
        "calls": [
          "events.select("id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)").eq("status", "Confirmed")",
        ],
        "published": [],
        "status": 500,
      }
    `);
  });

  it("gives one listed event, found by id among the Confirmed ones", async () => {
    expect(await one("1", { reply: { "events.select": { data: event(1) } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "event": {
            "accessibility": "Step-free entrance",
            "description": "Movies",
            "endTime": "12:00",
            "id": 1,
            "name": "Film Night",
            "open": true,
            "organiserName": "Olive",
            "proposedDate": "2099-06-01",
            "registrationState": "OPEN",
            "startTime": "10:00",
          },
        },
        "calls": [
          "events.select("id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)").eq("id", 1).eq("status", "Confirmed").maybeSingle()",
        ],
        "published": [],
        "status": 200,
      }
    `);
  });

  it("answers 400 for a malformed id", async () => {
    expect(await one("abc")).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Invalid event id",
        },
        "calls": [],
        "published": [],
        "status": 400,
      }
    `);
    for (const id of ["0", "-1", "1.5", "2147483648"]) expect([id, (await one(id)).status]).toEqual([id, 400]);
  });

  it("answers 404 for an event that is missing or not listed, and 500 for a failed read", async () => {
    expect(await one("1", { reply: { "events.select": { data: null } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Event not found",
        },
        "calls": [
          "events.select("id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)").eq("id", 1).eq("status", "Confirmed").maybeSingle()",
        ],
        "published": [],
        "status": 404,
      }
    `);
    expect((await one("1", { reply: { "events.select": { data: event(1, { registration_open_date: null }) } } })).status).toBe(404);
    expect(await one("1", { reply: { "events.select": { error: { message: "x" } } } })).toMatchInlineSnapshot(`
      {
        "body": {
          "error": "Failed to load the event",
        },
        "calls": [
          "events.select("id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)").eq("id", 1).eq("status", "Confirmed").maybeSingle()",
        ],
        "published": [],
        "status": 500,
      }
    `);
  });
});
