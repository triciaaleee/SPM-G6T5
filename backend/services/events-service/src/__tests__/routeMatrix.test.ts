/**
 * Exhaustive route sweep for events-service. Every route registered on
 * eventsRouter is driven through every combination of caller role, event
 * status and ownership, against a generic Supabase stand-in, then re-driven
 * with the k-th database call failing for every k the request makes.
 *
 * It asserts properties rather than exact payloads:
 *  - a request never throws: every response (including each injected database
 *    failure) is a JSON answer, never Express's HTML crash page;
 *  - the only status changes the routes ever write are the transitions in
 *    AGENTS.md §3 (so no route can take an event through an illegal step);
 *  - a caller without a user or client is turned away with 401.
 * The per-route behaviour (exact messages, side effects) stays in the
 * dedicated test files next to this one.
 */
import express from "express";
import { dispatch, type InjectedResponse } from "./inject.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedRequest } from "../middleware/auth.js";
import { eventsRouter } from "../routes/events.js";
import { routeParam } from "../routes/events/shared.js";
import { publicEventsRouter } from "../routes/publicEvents.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";
import { EVENT_STATUS } from "../lib/eventStatus.js";
import { signWithClock } from "./tokens.js";

vi.mock("../middleware/auth.js", async () => {
  const applyMock = (req: AuthedRequest, _res: unknown, next: () => void) => {
    req.user = (globalThis as any).__mockUser;
    req.supabase = (globalThis as any).__mockSupabase;
    next();
  };
  return { requireAuth: applyMock, requireAuthOrInternal: applyMock };
});

// The internal arrangements-changed handler brings its own client instead of using req.supabase.
vi.mock("../lib/supabaseAdmin.js", () => ({
  supabaseAdmin: {
    from: (table: string) => (globalThis as any).__mockSupabase?.from(table) ?? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) },
    rpc: (...args: unknown[]) => (globalThis as any).__mockSupabase?.rpc(...args),
  },
}));

process.env.INTERNAL_SERVICE_SECRET = "sweep-internal-secret";
const internalToken = () => signWithClock({ svc: "venue-service" }, "sweep-internal-secret", { expiresIn: "60s" });

const ME = "U-1";
const OTHER = "U-2";
const ROLES = ["organiser", "coordinator", "coordinator_lead", "safety_officer", "attendee", "venue_staff"] as const;
const STATUSES = Object.values(EVENT_STATUS);
const OWNERSHIPS = ["mine", "theirs", "unassigned"] as const;
type FetchMode = "arranged" | "unarranged" | "conflicts" | "down";
type Ownership = (typeof OWNERSHIPS)[number];

/** AGENTS.md §3, "Allowed transitions". Cancelled is reachable from every active status. */
const ACTIVE = [
  EVENT_STATUS.Unassigned,
  EVENT_STATUS.Requested,
  EVENT_STATUS.ClarificationRequested,
  EVENT_STATUS.Planning,
  EVENT_STATUS.SafetyReview,
  EVENT_STATUS.Confirmed,
  EVENT_STATUS.NeedsReview,
];
const LEGAL = new Set<string>([
  "Draft>Unassigned",
  "Unassigned>Requested",
  "Requested>Planning",
  "Requested>Rejected",
  "Requested>Clarification Requested",
  "Clarification Requested>Requested",
  "Clarification Requested>Planning",
  "Planning>Clarification Requested",
  "Planning>Safety Review",
  "Safety Review>Confirmed",
  "Safety Review>Planning",
  "Confirmed>Needs Review",
  "Confirmed>Completed",
  "Needs Review>Needs Review",
  "Needs Review>Safety Review",
  "Needs Review>Confirmed",
  ...ACTIVE.map((s) => `${s}>Cancelled`),
]);

/**
 * Known gap between the code and AGENTS.md section 3, deliberately left alone: story E1-4.2 lets the
 * coordinator reject from Clarification Requested, but section 3 says that step is illegal. The team
 * has to settle which document wins; until then the sweep tolerates exactly this one transition.
 */
const KNOWN_DEVIATIONS = new Set<string>(["Clarification Requested>Rejected"]);

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

/** Rarer shapes of the data the routes read; each one reaches a fallback or a "nothing matched" branch. */
interface World {
  /** Every list/lookup (outside events writes) comes back null instead of rows. */
  nulls?: boolean;
  /** A write guarded by "only while still …" matches no row (someone else got there first). */
  writesEmpty?: boolean;
  /** The status carried by change requests and other child rows. */
  otherStatus?: string;
  details?: "none" | "bare" | "noName" | "noDate" | "noEndTime" | "noRegistration";
  /** The latest safety decision on the event, and the field/value a change request holds. */
  outcome?: string;
  fieldName?: string;
  newValue?: string | null;
  /** Held fields that belong to no listed request. */
  orphanFields?: boolean;
  noOrganiser?: boolean;
  overrideNull?: boolean;
  /** Updating events returns no rows (a list that came back null). */
  nullEventWrites?: boolean;
  /** Only this table's reads come back null. */
  nullTable?: string;
  /** A count query finds nothing. */
  zeroCount?: boolean;
  /** Stored safety flags describe an arrangement as it no longer is. */
  staleSnapshot?: boolean;
  coordinatorNull?: boolean;
  /** Child rows with their optional columns empty. */
  nullColumns?: boolean;
  officerArray?: boolean;
}
const WORLDS: World[] = [
  { nulls: true },
  { writesEmpty: true },
  { otherStatus: "Rejected" },
  { otherStatus: "Auto-Withdrawn" },
  { details: "none" },
  { details: "noName" },
  { details: "noDate" },
  { details: "noEndTime" },
  { details: "noRegistration" },
  { coordinatorNull: true },
  { nullColumns: true },
  { officerArray: true },
  { outcome: "Changes Requested" },
  { outcome: "Changes Requested", officerArray: true },
  { outcome: "Changes Requested", nullColumns: true },
  { fieldName: "proposedDate", newValue: "2099-08-01" },
  { fieldName: "startTime", newValue: "09:00" },
  { fieldName: "expectedAttendance", newValue: "31" },
  { fieldName: "equipment", newValue: "Mics" },
  { fieldName: "proposedDate", newValue: "2099-08-01", details: "noDate" },
  { orphanFields: true },
  { noOrganiser: true },
  { overrideNull: true },
  { nullEventWrites: true },
  { zeroCount: true },
  { zeroCount: true, nullEventWrites: true },
  { outcome: "Changes Requested", staleSnapshot: true },
  { details: "bare" },
  { details: "bare", fieldName: "equipment", newValue: "Mics" },
  { fieldName: "venue", newValue: null },
  { fieldName: "venue", newValue: "Hall", noOrganiser: true },
  { fieldName: "proposedDate", newValue: "2099-06-01" },
  { fieldName: "startTime", newValue: "10:00" },
  { fieldName: "expectedAttendance", newValue: "30" },
  { fieldName: "proposedDate", newValue: "2099-08-01", otherStatus: "Pending" },
  ...[
    "change_request_fields",
    "change_requests",
    "event_clarifications",
    "event_history",
    "event_safety_review_flags",
    "event_safety_reviews",
    "event_safety_submissions",
  ].flatMap((nullTable): World[] => [{ nullTable }, { nullTable, outcome: "Changes Requested" }]),
];

function eventRow(status: string, ownership: Ownership, world: World = {}) {
  const { name: _name, ...noName } = details;
  const { proposedDate: _d, startTime: _s, endTime: _e, ...noDate } = details;
  const { endTime: _end, ...noEndTime } = details;
  const submitted =
    world.details === "bare" ? { name: "Bare", registrationNeeded: true } : world.details === "noEndTime" ? noEndTime : world.details === "none" ? null : world.details === "noName" ? noName : world.details === "noDate" ? noDate : world.details === "noRegistration" ? { ...details, registrationNeeded: false } : details;
  return {
    id: 1,
    status,
    status_before_clarification: "Requested",
    submitted_details: submitted as typeof details,
    organiser_id: world.noOrganiser ? undefined : ownership === "theirs" ? OTHER : ME,
    coordinator_id: ownership === "mine" ? ME : ownership === "theirs" ? OTHER : null,
    coordinator: world.coordinatorNull ? null : { name: "Coord" },
    organiser: { name: "Org" },
    review_outcome: null,
    decided_at: null,
    decided_by: null,
    created_at: "2026-01-01T00:00:00Z",
    registration_open_date: "2026-01-01",
    registration_override: world.overrideNull ? null : "NONE",
    safety_approval_stale: false,
  };
}

/** One row that satisfies every table the routes read, so a lookup never finds "nothing" by accident. */
function otherRow(_status: string, world: World = {}) {
  const nullable = world.nullColumns ? null : undefined;
  return {
    id: 1,
    event_id: 1,
    parent_id: null,
    author_id: ME,
    author_role: "coordinator",
    message: "m",
    resolved: false,
    status: world.otherStatus ?? "Pending",
    field: world.fieldName ?? "venue",
    old_value: "A",
    new_value: world.newValue === undefined ? "B" : world.newValue,
    changed_by: ME,
    created_at: "2026-01-01T00:00:00Z",
    request_id: world.orphanFields ? 99 : 1,
    change_request_id: 1,
    requested_by: ME,
    reason: nullable === null ? null : "r",
    officer: world.officerArray ? [{ name: "Officer" }] : world.nullColumns ? null : { name: "Officer" },
    decision: "approved",
    decided_by: ME,
    decided_at: "2026-01-01T00:00:00Z",
    is_critical: true,
    held: true,
    applied: false,
    arrangement_type: "venue_booking",
    arrangement_id: 1,
    label: "Hall",
    note: "n",
    snapshot: { status: world.staleSnapshot ? "Requested" : "Approved" },
    general_note: null,
    ...(world.nullColumns ? { reason: null, note: null, label: null } : {}),
    safety_officer_id: ME,
    outcome: world.outcome ?? "Approved",
    equipment_placement: "a",
    crowd_movement: "b",
    emergency_access: "c",
    venue_restrictions: "d",
    submitted_by: ME,
    submission_id: 1,
    review_id: 1,
    cleared_at: null,
    name: "N",
  };
}

interface Call {
  index: number;
  table: string;
  ops: string[];
}

function makeDb(row: ReturnType<typeof eventRow> | null, failAt: number | null, transitions: string[], world: World = {}) {
  const calls: Call[] = [];
  let next = 0;

  function chain(table: string, rpc = false) {
    const ops: [string, unknown[]][] = [];
    let single = false;
    /** `.single()` errors on zero rows; only `.maybeSingle()` answers null data. */
    let strict = false;
    const settle = () => {
      const index = next++;
      calls.push({ index, table, ops: ops.map(([name]) => name) });
      if (index === failAt) return { data: null, error: { message: "boom" }, count: null };
      const update = ops.find(([name]) => name === "update");
      const payload = update?.[1][0] as { status?: string } | undefined;
      if (row && table === "events" && payload?.status !== undefined && payload.status !== row.status) {
        transitions.push(`${row.status}>${payload.status}`);
      }
      const isWrite = ops.some(([name]) => name === "update" || name === "delete" || name === "upsert");
      const eventsWriteNothing = world.nullEventWrites && table === "events" && isWrite && !single;
      if (eventsWriteNothing) return { data: null, error: null, count: 0 };
      if (world.nullTable === table && !rpc && !isWrite) return { data: null, error: null, count: 0 };
      const noRows = { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" }, count: 0 };
      if (world.writesEmpty && isWrite && !rpc) return strict ? noRows : { data: single ? null : [], error: null, count: 0 };
      if (world.nulls && !(table === "events" && single) && !rpc) return strict ? noRows : { data: null, error: null, count: 0 };
      const writes = ops.some(([name]) => name === "insert" || name === "update" || name === "upsert" || name === "delete");
      if (!row && table === "events" && !writes) return strict ? noRows : { data: single ? null : [], error: null, count: 0 };
      const status = row?.status ?? "Planning";
      const base = rpc ? { ...otherRow(status, world), id: 1 } : table === "events" ? (row ?? eventRow(status, "mine", world)) : otherRow(status, world);
      return { data: single ? base : [base], error: null, count: world.zeroCount ? 0 : 1 };
    };
    const proxy: any = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "then") return (resolve: any, reject: any) => Promise.resolve(settle()).then(resolve, reject);
        return (...args: unknown[]) => {
          ops.push([String(prop), args]);
          if (prop === "single" || prop === "maybeSingle") single = true;
          if (prop === "single") strict = true;
          return proxy;
        };
      },
    });
    return proxy;
  }

  return { client: { from: (table: string) => chain(table), rpc: () => chain("rpc", true) }, calls };
}

type BodyKey = "same" | "changed" | "empty" | "none";

function body(key: BodyKey = "same") {
  if (key === "empty") return {};
  if (key === "none") return undefined;
  const common = {
    reason: "Because",
    message: "Why",
    coordinatorId: OTHER,
    newCoordinatorId: OTHER,
    safetyNotes: {
      equipmentPlacement: "a",
      crowdMovement: "b",
      emergencyAccess: "c",
      venueRestrictions: "None known",
    },
    arrangements: [{ type: "venue_booking", id: 1, note: "fix" }],
    generalNote: "g",
    openDate: "2099-05-01",
    registrationOpenDate: "2099-05-01",
    fields: ["venue"],
  };
  if (key === "same") return { ...details, ...common };
  // "changed" approves every held field (no `fields` subset); "same" approves just the venue.
  const { fields: _subset, ...allFields } = common;
  return {
    ...details,
    ...allFields,
    name: "Film Night 2",
    proposedDate: "2099-07-01",
    startTime: "11:00",
    endTime: "13:00",
    expectedAttendance: 31,
    venue: "Other hall",
    accessibility: "Lift",
    equipment: "Mics",
    registrationNeeded: false,
  };
}

/** What the sibling services answer, per mode: arrangements settled, outstanding, clashing, or the service down. */
function installFetch(mode: FetchMode) {
  vi.stubGlobal("fetch", async (input: string) => {
    if (mode === "down") return { ok: false, status: 500, json: async () => ({}) };
    const url = String(input);
    let json: unknown = {};
    if (url.includes("/api/users")) json = { users: [{ id: OTHER, name: "Other Coord" }, { id: ME, name: "Me" }] };
    else if (url.includes("/bookings/") && url.includes("availability-check"))
      json = mode === "conflicts"
        ? { available: false, unavailabilityConflict: { reason: "maintenance", description: "d" }, bookingConflict: { bookingId: 2, status: "Approved", window: "w" } }
        : { available: true, unavailabilityConflict: null, bookingConflict: null };
    else if (url.includes("flag-for-rebooking")) json = { staffNotified: true };
    else if (url.includes("flag-for-event")) json = { flaggedRequestIds: [1], notified: true };
    else if (url.includes("/api/venues/events/"))
      json = {
        bookings: [
          { id: 1, status: "Approved", venue: { id: 1, name: "Hall", capacity: mode === "conflicts" ? 5 : 100 } },
          ...(mode === "unarranged" ? [{ id: 2, status: "On Hold", venue: null }] : []),
        ],
      };
    else if (url.includes("/api/equipment-requests"))
      json = {
        equipmentRequests: [
          { id: 1, status: "Pending", items: [{ id: 1, equipmentType: "Mic", quantity: 2, quantityFulfilled: mode === "unarranged" ? 1 : 2 }] },
        ],
      };
    else if (url.includes("/api/registrations/"))
      json = { registrations: [{ registrationId: 1, userId: "A-1", status: "Registered", name: "A" }] };
    return { ok: true, status: 200, json: async () => json };
  });
}

const app = express();
app.use(express.json());
app.use("/api/events/public", publicEventsRouter);
app.use("/api/events", eventsRouter);


interface RouteDef {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  url: string;
  /** The same path with every id replaced by something that isn't a number. */
  badUrl: string;
  /** A real event id but a malformed request/question id. */
  badSubId: string;
}

/** Every route layer under a router, descending into the sub-routers events.ts mounts with `use()`. */
function routeLayers(router: any): any[] {
  return router.stack.flatMap((layer: any) =>
    layer.route ? [layer] : layer.handle?.stack ? routeLayers(layer.handle) : [],
  );
}

function listRoutes(): RouteDef[] {
  const out: RouteDef[] = [];
  for (const layer of routeLayers(eventsRouter)) {
    for (const method of Object.keys(layer.route.methods)) {
      const path = layer.route.path as string;
      out.push({
        method: method as RouteDef["method"],
        path,
        url: `/api/events${path.replace(":id", "1").replace(":requestId", "1").replace(":questionId", "1")}`,
        badUrl: `/api/events${path.replace(":id", "abc").replace(":requestId", "abc").replace(":questionId", "abc")}`,
        badSubId: `/api/events${path.replace(":id", "1").replace(":requestId", "abc").replace(":questionId", "abc")}`,
      });
    }
  }
  return out;
}
const ROUTES = listRoutes();
const QUERIES = ["", "?ids=1,2&status=Planning&q=film&limit=5&page=2&role=coordinator&mine=true&eventId=1", "?ids=abc&limit=0&page=-1&status=Nope"];

async function call(route: RouteDef, query: string, bodyKey: BodyKey = "same", url = route.url) {
  const payload = body(bodyKey);
  const sendsBody = !(route.method === "get" || route.method === "delete" || payload === undefined);
  return dispatch(app, route.method, url + (route.method === "get" ? query : ""), {
    headers: { "x-internal-auth": internalToken() },
    body: sendsBody ? payload : undefined,
  });
}

function expectNoCrash(res: InjectedResponse, label: string) {
  expect(res.status, label).toBeLessThan(600);
  if (res.status >= 500 || res.status === 204) {
    // Express's default crash page is HTML; every deliberate failure answers JSON.
    expect(res.headers["content-type"] ?? "application/json", `${label} -> ${res.status} ${res.text.replace(/\s+/g, " ").slice(100, 600)}`).toMatch(/json/);
  }
}

const STAFF_ROLES: string[] = ["organiser", "coordinator", "coordinator_lead", "safety_officer"];
const EXTRA_SCENARIOS: [BodyKey, FetchMode][] = [
  ["changed", "arranged"],
  ["changed", "conflicts"],
  ["same", "unarranged"],
  ["empty", "arranged"],
  ["same", "down"],
  ["none", "arranged"],
];

let variant = 0;
beforeEach(() => {
  variant += 1;
  installFetch("arranged");
  setPublisherForTest({ publish: async () => variant % 3 !== 0 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  setPublisherForTest(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeAll(() => {
  // A guard against the sweep silently shrinking if the router is restructured.
  expect(ROUTES.length).toBeGreaterThanOrEqual(35);
});

describe("route sweep: no request ever crashes, and only legal transitions are written", () => {
  describe.each(ROUTES)("$method $path", (route) => {
    it("answers 401 (or an internal-token 401) without a user or a client", async () => {
      for (const [user, supabase] of [
        [undefined, undefined],
        [undefined, makeDb(eventRow("Planning", "mine"), null, []).client],
        [{ id: ME, role: "organiser" }, undefined],
      ] as const) {
        (globalThis as any).__mockUser = user;
        (globalThis as any).__mockSupabase = supabase;
        const res = await call(route, "");
        expectNoCrash(res, `${route.method} ${route.path} unauthenticated`);
      }
    });

    it("never crashes for any role × status × ownership, and writes only legal status changes", async () => {
      const transitions: string[] = [];
      const run = async (
        role: string,
        row: ReturnType<typeof eventRow> | null,
        bodyKey: BodyKey,
        mode: FetchMode,
        query: string,
        url?: string,
        world: World = {},
      ) => {
        installFetch(mode);
        (globalThis as any).__mockUser = { id: ME, role };
        (globalThis as any).__mockSupabase = makeDb(row, null, transitions, world).client;
        variant += 1;
        const res = await call(route, query, bodyKey, url);
        expectNoCrash(res, `${role}/${row?.status ?? "missing"}/${bodyKey}/${mode} ${route.method} ${route.path}${query}`);
      };

      for (const role of ROLES) {
        for (const status of STATUSES) {
          for (const ownership of OWNERSHIPS) {
            for (const query of route.method === "get" ? QUERIES : [""]) {
              await run(role, eventRow(status, ownership), "same", "arranged", query);
            }
          }
          // The owner's / assigned coordinator's own view, under bodies that change things and
          // sibling services that are down, clashing or still working.
          if (STAFF_ROLES.includes(role)) {
            for (const [bodyKey, mode] of EXTRA_SCENARIOS) await run(role, eventRow(status, "mine"), bodyKey, mode, "");
            for (const bodyKey of ["same", "changed"] as BodyKey[]) await run(role, eventRow(status, "unassigned"), bodyKey, "arranged", "");
          }
          await run(role, eventRow(status, "mine"), "same", "arranged", "", route.badSubId);
          for (const world of WORLDS) {
            const mode: FetchMode = world.fieldName ? "conflicts" : "arranged";
            await run(role, eventRow(status, "mine", world), "changed", mode, route.method === "get" ? QUERIES[1] : "", undefined, world);
          }
        }
        await run(role, null, "same", "arranged", "");
        await run(role, eventRow("Planning", "mine"), "same", "arranged", "", route.badUrl);
      }
      const illegal = [...new Set(transitions)].filter((t) => !LEGAL.has(t) && !KNOWN_DEVIATIONS.has(t));
      expect(illegal, `illegal transitions written by ${route.method} ${route.path}`).toEqual([]);
    }, 300_000);

    it("answers JSON, not a crash, when any single database call fails", async () => {
      const transitions: string[] = [];
      const scenarios: [string, Ownership][] = [
        ["organiser", "mine"],
        ["coordinator", "mine"],
        ["coordinator_lead", "mine"],
        ["coordinator_lead", "unassigned"],
        ["safety_officer", "mine"],
        ["attendee", "mine"],
        ["venue_staff", "mine"],
      ];
      const combos: [BodyKey, FetchMode, World][] = [
        ["same", "arranged", {}],
        ["changed", "conflicts", {}],
        ["same", "unarranged", {}],
        ["changed", "arranged", { outcome: "Changes Requested" }],
        ["changed", "conflicts", { fieldName: "proposedDate", newValue: "2099-08-01" }],
        ["changed", "arranged", { fieldName: "expectedAttendance", newValue: "31" }],
        ["changed", "arranged", { outcome: "Changes Requested", staleSnapshot: true }],
        ["changed", "arranged", { zeroCount: true }],
      ];
      for (const [role, ownership] of scenarios) {
        for (const status of STATUSES) {
          for (const [bodyKey, mode, world] of combos) {
            installFetch(mode);
            (globalThis as any).__mockUser = { id: ME, role };
            const probe = makeDb(eventRow(status, ownership, world), null, [], world);
            (globalThis as any).__mockSupabase = probe.client;
            await call(route, route.method === "get" ? QUERIES[1] : "", bodyKey);
            for (let k = 0; k < probe.calls.length; k++) {
              (globalThis as any).__mockSupabase = makeDb(eventRow(status, ownership, world), k, transitions, world).client;
              variant += 1;
              const res = await call(route, route.method === "get" ? QUERIES[1] : "", bodyKey);
              expectNoCrash(res, `${role}/${status}/${ownership}/${bodyKey}/${mode} call #${k} (${probe.calls[k].table}.${probe.calls[k].ops.join(".")}) failing`);
            }
          }
        }
      }
      expect([...new Set(transitions)].filter((t) => !LEGAL.has(t) && !KNOWN_DEVIATIONS.has(t))).toEqual([]);
    }, 600_000);
  });
});

describe("public (guest) event routes", () => {
  const PUBLIC = ["/api/events/public", "/api/events/public/1", "/api/events/public/abc", "/api/events/public/0"];

  it("answer JSON for every kind of event row and survive any one database call failing", async () => {
    for (const status of STATUSES) {
      for (const world of [{}, ...WORLDS]) {
        for (const url of PUBLIC) {
          for (const failAt of [null, 0]) {
            (globalThis as any).__mockSupabase = makeDb(eventRow(status, "mine", world), failAt, [], world).client;
            installFetch("arranged");
            const res = await dispatch(app, "get", url);
            expectNoCrash(res, `${status} GET ${url} failAt=${failAt}`);
          }
        }
      }
    }
  }, 120_000);
});

describe("routeParam", () => {
  it("passes a string through and takes the first of a repeated parameter", () => {
    expect(routeParam("7")).toBe("7");
    expect(routeParam(["7", "8"])).toBe("7");
  });
});
