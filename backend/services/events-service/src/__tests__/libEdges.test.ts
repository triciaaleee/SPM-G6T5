import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth, requireAuthOrInternal } from "../middleware/auth.js";
import { requireInternal } from "../middleware/internal.js";
import { signToken, TokenExpiredError, verifyToken } from "../lib/jwt.js";
import { isPositiveInteger, isUuid } from "../lib/validation.js";
import { eventEndsAt, eventStartsAt, hasEventEnded, hasEventStarted, localDateStart } from "../lib/eventTiming.js";
import { normaliseDraftEventRequest, validateEventRequest } from "../lib/validateEventRequest.js";
import { verifyInternalToken } from "../lib/internalAuth.js";
import { fetchEventRegistrations } from "../lib/registrationsClient.js";
import {
  checkBookingAvailability,
  fetchEventEquipmentRequests,
  fetchEventVenueBookings,
  flagBookingForRebooking,
  flagEquipmentForReassessment,
} from "../lib/arrangementsClient.js";
import { diffSubmittedDetails, diffSubmittedDetailsStructured } from "../lib/diffSubmittedDetails.js";
import { publishDurably } from "../lib/outbox.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";
import {
  arrangementOptions,
  combinedReason,
  currentArrangements,
  MAX_SAFETY_CHANGE_NOTE_LENGTH,
  parseChangeRequest,
  resolveFlags,
} from "../lib/safetyChanges.js";
import {
  describeOutstanding,
  equipmentIsRequired,
  findOutstandingArrangements,
  hasOutstanding,
  MAX_SAFETY_NOTE_LENGTH,
  parseSafetyNotes,
} from "../lib/safetyReview.js";
import { committedFieldValue, validateChangeRequestFields } from "../lib/changeRequestFields.js";
import type { ValidatedEventRequest } from "../lib/validateEventRequest.js";
import { getRegistrationState, isListed, parseOverride } from "../lib/registrationPeriod.js";
import { announceAttendanceChange, announceReschedule } from "../lib/reschedule.js";
import { flushOutbox } from "../lib/outbox.js";
import { attendanceChanged, attendanceOf, scheduleChanged, scheduleOf } from "../lib/reschedule.js";
import { fetchCoordinatorLeads, fetchCoordinators } from "../lib/usersClient.js";
import { clock, setClockForTest } from "../lib/clock.js";
import { signWithClock } from "./tokens.js";

vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: { marker: "admin" } }));

const SECRET = "test-jwt-secret";

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function run(authorization?: string) {
  const req = { headers: authorization === undefined ? {} : { authorization } } as unknown as AuthedRequest;
  const res = mockRes();
  const next = vi.fn();
  requireAuth(req, res, next);
  return { req, res, next };
}

beforeEach(() => {
  process.env.JWT_SECRET = SECRET;
});

describe("clock", () => {
  it("is pinned by a date or an ISO string, and hands out a fresh Date each time", () => {
    setClockForTest("2030-05-06T07:08:09.000Z");
    const first = clock.now();
    expect(first.toISOString()).toBe("2030-05-06T07:08:09.000Z");
    first.setUTCFullYear(1999); // a caller changing its copy must not move the clock
    expect(clock.now().toISOString()).toBe("2030-05-06T07:08:09.000Z");
    setClockForTest(new Date("2031-01-02T03:04:05.000Z"));
    expect(clock.now().toISOString()).toBe("2031-01-02T03:04:05.000Z");
  });

  it("can be a custom clock that moves on", () => {
    let tick = 0;
    setClockForTest({ now: () => new Date(Date.UTC(2030, 0, 1, 0, 0, tick++)) });
    expect(clock.now().toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2030-01-01T00:00:01.000Z");
  });

  it("is the system clock again when reset", () => {
    setClockForTest("2030-05-06T07:08:09.000Z");
    setClockForTest();
    const before = Date.now();
    const read = clock.now().getTime();
    expect(read).toBeGreaterThanOrEqual(before);
    expect(read).toBeLessThanOrEqual(Date.now());
  });
});

describe("jwt", () => {
  it("round-trips sub and role and sets an expiry about a day out", () => {
    const payload = verifyToken(signToken({ sub: "U-1", role: "organiser" }));
    expect(payload.sub).toBe("U-1");
    expect(payload.role).toBe("organiser");
    const secondsLeft = (payload.exp as number) - Math.floor(clock.now().getTime() / 1000);
    expect(secondsLeft).toBeGreaterThan(86_400 - 5);
    expect(secondsLeft).toBeLessThanOrEqual(86_400);
  });

  it("throws TokenExpiredError for an expired token", () => {
    const token = signWithClock({ sub: "U-1", role: "organiser" }, SECRET, { expiresIn: -1 });
    expect(() => verifyToken(token)).toThrow(TokenExpiredError);
  });

  it("throws the raw error (not TokenExpiredError) for a wrong secret, garbage and alg none", () => {
    const forged = signWithClock({ sub: "U-1", role: "coordinator" }, "other-secret");
    expect(() => verifyToken(forged)).toThrow(/invalid signature/);
    expect(() => verifyToken(forged)).not.toThrow(TokenExpiredError);
    expect(() => verifyToken("not.a.jwt")).toThrow();
    expect(() => verifyToken("")).toThrow();
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"sub":"U-1","role":"coordinator"}').toString("base64url")}.`;
    expect(() => verifyToken(none)).toThrow();
  });

  it("rejects a token whose payload was tampered with", () => {
    const [h, , s] = signToken({ sub: "U-1", role: "organiser" }).split(".");
    const evil = Buffer.from(JSON.stringify({ sub: "U-1", role: "coordinator_lead" })).toString("base64url");
    expect(() => verifyToken(`${h}.${evil}.${s}`)).toThrow(/invalid signature/);
  });

  it("explains a missing JWT_SECRET for both sign and verify", () => {
    process.env.JWT_SECRET = "";
    expect(() => signToken({ sub: "U-1", role: "organiser" })).toThrow(/JWT_SECRET is not set/);
    expect(() => verifyToken("x.y.z")).toThrow(/JWT_SECRET is not set/);
  });
});

describe("requireAuth", () => {
  it("attaches user and the admin client and calls next for a valid token", () => {
    const { req, res, next } = run(`Bearer ${signToken({ sub: "U-9", role: "coordinator" })}`);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.user).toEqual({ id: "U-9", role: "coordinator" });
    expect(req.supabase).toEqual({ marker: "admin" });
  });

  it.each([undefined, "", "Bearer", "Bearer ", "bearer abc", "Basic abc", "Token abc"])(
    "answers 401 no_token for the header %j",
    (header) => {
      const { res, next } = run(header);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ error: "Missing bearer token", code: "no_token" });
    },
  );

  it("answers 401 token_expired for an expired token", () => {
    const { res, next } = run(`Bearer ${signWithClock({ sub: "U", role: "r" }, SECRET, { expiresIn: -1 })}`);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "token_expired" }));
  });

  it.each(["garbage", signWithClock({ sub: "U", role: "r" }, "wrong-secret")])("answers 401 invalid_token for %s", (token) => {
    const { req, res, next } = run(`Bearer ${token}`);
    expect(next).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid token", code: "invalid_token" });
  });
});

describe("validation", () => {
  it.each([
    ["123e4567-e89b-12d3-a456-426614174000", true],
    ["123E4567-E89B-12D3-A456-426614174000", true],
    ["123e4567-e89b-12d3-a456-42661417400", false],
    ["123e4567-e89b-12d3-a456-4266141740000", false],
    ["123e4567e89b12d3a456426614174000", false],
    ["g23e4567-e89b-12d3-a456-426614174000", false],
    [" 123e4567-e89b-12d3-a456-426614174000", false],
    ["123e4567-e89b-12d3-a456-426614174000\n", false],
    ["", false],
  ])("isUuid(%j) is %s", (value, expected) => {
    expect(isUuid(value)).toBe(expected);
  });

  it.each([
    ["1", true],
    ["42", true],
    ["2147483647", true],
    ["2147483648", false],
    ["9007199254740993", false],
    ["9999999999999999999", false],
    ["0", false],
    ["01", false],
    ["-1", false],
    ["1.5", false],
    ["1e3", false],
    ["abc", false],
    [" 1", false],
    ["1 ", false],
    ["1\n", false],
    ["", false],
    ["1; DROP TABLE events", false],
  ])("isPositiveInteger(%j) is %s", (value, expected) => {
    expect(isPositiveInteger(value)).toBe(expected);
  });
});

describe("usersClient", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.USER_SERVICE_URL;
    delete process.env.USER_SERVICE_PORT;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const cases = [
    ["fetchCoordinators", fetchCoordinators, "role=coordinator"],
    ["fetchCoordinatorLeads", fetchCoordinatorLeads, "role=coordinator_lead"],
  ] as const;

  describe.each(cases)("%s", (_name, fn, query) => {
    it("forwards the caller's token and returns the users", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ users: [{ id: "C-1", name: "Ann" }] }) });
      const result = await fn("Bearer abc");
      expect(result).toEqual({ status: "ok", coordinators: [{ id: "C-1", name: "Ann" }] });
      expect(fetchMock).toHaveBeenCalledWith(`http://localhost:4002/api/users?${query}`, {
        headers: { Authorization: "Bearer abc" },
      });
    });

    it("returns an empty list when the body has no users key", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
      expect(await fn("Bearer abc")).toEqual({ status: "ok", coordinators: [] });
    });

    it("reports an error for a non-ok response", async () => {
      fetchMock.mockResolvedValue({ ok: false, json: async () => ({ users: [] }) });
      expect(await fn("Bearer abc")).toEqual({ status: "error" });
    });

    it("reports an error when the network call or the JSON parse throws", async () => {
      fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      expect(await fn("Bearer abc")).toEqual({ status: "error" });
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error("bad json"); } });
      expect(await fn("Bearer abc")).toEqual({ status: "error" });
    });

    it("prefers USER_SERVICE_URL, then USER_SERVICE_PORT, then 4002", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ users: [] }) });
      process.env.USER_SERVICE_PORT = "5555";
      await fn("t");
      expect(fetchMock.mock.calls[0][0]).toBe(`http://localhost:5555/api/users?${query}`);
      process.env.USER_SERVICE_URL = "http://users.internal";
      await fn("t");
      expect(fetchMock.mock.calls[1][0]).toBe(`http://users.internal/api/users?${query}`);
    });
  });
});

const VALID = {
  name: "  Spring Gala ",
  purpose: "Fundraiser",
  description: "Annual dinner",
  proposedDate: "2099-06-01",
  startTime: "10:00",
  endTime: "12:00",
  expectedAttendance: 100,
  venue: "Hall",
  accessibility: "Ramp",
  equipment: "None",
  technicalSupport: "None",
  registrationNeeded: true,
};
const TEXT_FIELDS = ["name", "purpose", "description", "venue", "accessibility", "equipment", "technicalSupport"];
const todayIso = () => clock.now().toISOString().slice(0, 10);
const dayIso = (offset: number) => new Date(clock.now().getTime() + offset * 86_400_000).toISOString().slice(0, 10);

describe("validateEventRequest", () => {
  it("returns the trimmed, normalised value for a valid request", () => {
    const result = validateEventRequest(VALID);
    expect(result).toEqual({ valid: true, fields: {}, value: { ...VALID, name: "Spring Gala" } });
  });

  it.each(TEXT_FIELDS)("requires %s (undefined, null, empty, whitespace)", (field) => {
    for (const blank of [undefined, null, "", "   \t\n"]) {
      const result = validateEventRequest({ ...VALID, [field]: blank });
      expect(result.valid).toBe(false);
      expect(result.value).toBeUndefined();
      expect(result.fields).toEqual({ [field]: "This field is required." });
    }
  });

  it("reports every missing field at once for an empty body", () => {
    const result = validateEventRequest({});
    expect(Object.keys(result.fields).sort()).toEqual(
      [...TEXT_FIELDS, "proposedDate", "startTime", "endTime", "expectedAttendance"].sort(),
    );
  });

  it("accepts today, rejects yesterday, accepts tomorrow", () => {
    expect(validateEventRequest({ ...VALID, proposedDate: todayIso() }).valid).toBe(true);
    expect(validateEventRequest({ ...VALID, proposedDate: dayIso(-1) }).fields.proposedDate).toBe(
      "The proposed date cannot be in the past.",
    );
    expect(validateEventRequest({ ...VALID, proposedDate: dayIso(1) }).valid).toBe(true);
  });

  it.each(["tomorrow", "2099-99-99", "xx"])("rejects the unparseable date %j", (value) => {
    expect(validateEventRequest({ ...VALID, proposedDate: value }).fields.proposedDate).toBe("Enter a valid date.");
  });

  it.each(["startTime", "endTime"])("validates %s format and presence", (field) => {
    for (const bad of ["24:00", "9:5", "12:60", "1200", "ab:cd", "12:00pm", " 10:00", "10:00 ", "10:00\n", "99:10", "10:99"]) {
      expect(validateEventRequest({ ...VALID, [field]: bad }).fields[field]).toBe("Enter a valid time.");
    }
    for (const blank of [undefined, null, "", "  "]) {
      expect(validateEventRequest({ ...VALID, [field]: blank }).fields[field]).toBe("This field is required.");
    }
  });

  it.each(["00:00", "00:59", "01:00", "09:00", "19:59", "20:00", "23:59"])("accepts %s as a time of day", (time) => {
    const result = validateEventRequest({ ...VALID, startTime: time, endTime: "23:59" });
    expect(result.fields.startTime).toBeUndefined();
  });

  it("requires the end time to be strictly after the start time", () => {
    expect(validateEventRequest({ ...VALID, startTime: "10:00", endTime: "10:00" }).fields.endTime).toBe(
      "End time must be after the start time.",
    );
    expect(validateEventRequest({ ...VALID, startTime: "10:00", endTime: "09:59" }).fields.endTime).toBe(
      "End time must be after the start time.",
    );
    expect(validateEventRequest({ ...VALID, startTime: "10:00", endTime: "10:01" }).valid).toBe(true);
    expect(validateEventRequest({ ...VALID, startTime: "00:00", endTime: "00:01" }).valid).toBe(true);
    expect(validateEventRequest({ ...VALID, startTime: "09:59", endTime: "10:00" }).valid).toBe(true);
  });

  it("keeps the format error rather than adding an ordering error", () => {
    expect(validateEventRequest({ ...VALID, startTime: "25:00", endTime: "01:00" }).fields).toEqual({
      startTime: "Enter a valid time.",
    });
  });

  it.each([1, "1", " 7 ", 2.5, 1e9])("accepts expectedAttendance %j", (value) => {
    const result = validateEventRequest({ ...VALID, expectedAttendance: value });
    expect(result.valid).toBe(true);
    expect(result.value?.expectedAttendance).toBe(Number(value));
  });

  it.each([0, "0", -1, -0.5, "-3"])("rejects expectedAttendance %j as not above zero", (value) => {
    expect(validateEventRequest({ ...VALID, expectedAttendance: value }).fields.expectedAttendance).toBe(
      "Expected attendance must be greater than zero.",
    );
  });

  it.each(["abc", NaN, Infinity, "Infinity", {}, [1, 2]])("rejects expectedAttendance %j as not a number", (value) => {
    expect(validateEventRequest({ ...VALID, expectedAttendance: value }).fields.expectedAttendance).toBe(
      "Enter a valid number.",
    );
  });

  it.each([undefined, null, "", "  "])("requires expectedAttendance (%j)", (value) => {
    expect(validateEventRequest({ ...VALID, expectedAttendance: value }).fields.expectedAttendance).toBe(
      "This field is required.",
    );
  });

  it("reads registrationNeeded as true only for true or 'true'", () => {
    for (const yes of [true, "true"]) expect(validateEventRequest({ ...VALID, registrationNeeded: yes }).value?.registrationNeeded).toBe(true);
    for (const no of [false, "false", "TRUE", "yes", 1, 0, null, undefined, "", {}]) {
      expect(validateEventRequest({ ...VALID, registrationNeeded: no }).value?.registrationNeeded).toBe(false);
    }
  });

  it("keeps hostile and unicode text as plain, trimmed strings", () => {
    const name = "  <script>alert(1)</script>'; DROP TABLE events;-- 🎉 日本語 ";
    expect(validateEventRequest({ ...VALID, name }).value?.name).toBe(name.trim());
  });

  it("ignores unknown keys", () => {
    const result = validateEventRequest({ ...VALID, status: "Confirmed", id: 9 } as never);
    expect(result.value).not.toHaveProperty("status");
    expect(result.value).not.toHaveProperty("id");
  });
});

describe("normaliseDraftEventRequest", () => {
  it("turns an empty draft into blank strings and a null attendance", () => {
    expect(normaliseDraftEventRequest({})).toEqual({
      name: "",
      purpose: "",
      description: "",
      proposedDate: "",
      startTime: "",
      endTime: "",
      expectedAttendance: null,
      venue: "",
      accessibility: "",
      equipment: "",
      technicalSupport: "",
      registrationNeeded: false,
    });
  });

  it("trims strings and drops non-strings to blank", () => {
    const draft = normaliseDraftEventRequest({ name: "  Gala  ", purpose: 42, description: null, venue: {}, startTime: " 10:00 " });
    expect(draft.name).toBe("Gala");
    expect(draft.purpose).toBe("");
    expect(draft.description).toBe("");
    expect(draft.venue).toBe("");
    expect(draft.startTime).toBe("10:00");
  });

  it.each([
    [25, 25],
    ["25", 25],
    [0, 0],
    ["0", 0],
    [-5, -5],
    [2.5, 2.5],
    ["", null],
    ["  ", null],
    [null, null],
    [undefined, null],
    ["abc", null],
    [Infinity, null],
    [NaN, null],
  ])("attendance %j becomes %j", (input, expected) => {
    expect(normaliseDraftEventRequest({ expectedAttendance: input }).expectedAttendance).toBe(expected);
  });

  it("reads registrationNeeded like a submission does", () => {
    expect(normaliseDraftEventRequest({ registrationNeeded: true }).registrationNeeded).toBe(true);
    expect(normaliseDraftEventRequest({ registrationNeeded: "true" }).registrationNeeded).toBe(true);
    expect(normaliseDraftEventRequest({ registrationNeeded: "false" }).registrationNeeded).toBe(false);
    expect(normaliseDraftEventRequest({ registrationNeeded: 1 }).registrationNeeded).toBe(false);
  });
});

describe("eventTiming edges", () => {
  it("defaults a missing start time to midnight and a missing end time to 23:59", () => {
    expect(eventStartsAt({ proposedDate: "2026-11-10" })?.toISOString()).toBe("2026-11-09T16:00:00.000Z");
    expect(eventStartsAt({ proposedDate: "2026-11-10", startTime: null })?.toISOString()).toBe("2026-11-09T16:00:00.000Z");
    expect(eventEndsAt({ proposedDate: "2026-11-10", endTime: null })?.toISOString()).toBe("2026-11-10T15:59:00.000Z");
  });

  it.each([
    {},
    { proposedDate: 20261110 },
    { proposedDate: "2026-11-10 " },
    { proposedDate: " 2026-11-10" },
    { proposedDate: "2026-11-10T10:00" },
    { proposedDate: "26-11-10" },
    { proposedDate: "2026-1-1" },
    { proposedDate: "2026-02-30x" },
  ])("returns null for the date in %j", (details) => {
    expect(eventStartsAt({ ...details, startTime: "10:00" })).toBeNull();
    expect(eventEndsAt({ ...details, endTime: "10:00" })).toBeNull();
    expect(localDateStart((details as { proposedDate?: unknown }).proposedDate)).toBeNull();
  });

  it.each(["24:00", "10:60", "1000", "10:00:00", " 10:00", "10:00 ", "10:00\n", "xx:yy", 1000, true, {}])(
    "returns null for the time %j",
    (time) => {
      expect(eventStartsAt({ proposedDate: "2026-11-10", startTime: time })).toBeNull();
      expect(eventEndsAt({ proposedDate: "2026-11-10", endTime: time })).toBeNull();
    },
  );

  it.each(["00:00", "23:59", "12:30"])("reads %s", (time) => {
    expect(eventStartsAt({ proposedDate: "2026-11-10", startTime: time })).not.toBeNull();
    expect(eventEndsAt({ proposedDate: "2026-11-10", endTime: time })).not.toBeNull();
  });

  it("localDateStart is midnight Singapore time", () => {
    expect(localDateStart("2026-11-10")?.toISOString()).toBe("2026-11-09T16:00:00.000Z");
    expect(localDateStart("2026-13-45")).toBeNull();
    expect(localDateStart("2026-11-10x")).toBeNull();
    expect(localDateStart("x2026-11-10")).toBeNull();
  });

  it("flips exactly at the start and end instants (to the millisecond)", () => {
    const details = { proposedDate: "2026-11-10", startTime: "10:00", endTime: "18:00" };
    const start = eventStartsAt(details)!.getTime();
    const end = eventEndsAt(details)!.getTime();
    expect(hasEventStarted(details, new Date(start - 1))).toBe(false);
    expect(hasEventStarted(details, new Date(start))).toBe(true);
    expect(hasEventStarted(details, new Date(start + 1))).toBe(true);
    expect(hasEventEnded(details, new Date(end - 1))).toBe(false);
    expect(hasEventEnded(details, new Date(end))).toBe(true);
    expect(hasEventEnded(details, new Date(end + 1))).toBe(true);
  });

  it("treats an unreadable schedule as not started and not ended", () => {
    expect(hasEventStarted({}, new Date("2099-01-01"))).toBe(false);
    expect(hasEventEnded({}, new Date("2099-01-01"))).toBe(false);
  });

  it("uses Singapore, not UTC, for the day rollover (00:30 SGT is still the previous day in UTC)", () => {
    const details = { proposedDate: "2026-11-10", startTime: "00:30", endTime: "01:00" };
    expect(eventStartsAt(details)?.toISOString()).toBe("2026-11-09T16:30:00.000Z");
    expect(hasEventStarted(details, new Date("2026-11-09T16:29:59.999Z"))).toBe(false);
    expect(hasEventStarted(details, new Date("2026-11-09T16:30:00.000Z"))).toBe(true);
  });
});

describe("verifyInternalToken", () => {
  it("accepts a token signed with the internal secret and returns its payload", () => {
    process.env.INTERNAL_SERVICE_SECRET = "internal-secret";
    const token = signWithClock({ svc: "venue-service" }, "internal-secret");
    expect(verifyInternalToken(token).svc).toBe("venue-service");
  });

  it("rejects a user JWT signed with JWT_SECRET (the secrets must not be interchangeable)", () => {
    process.env.INTERNAL_SERVICE_SECRET = "internal-secret";
    expect(() => verifyInternalToken(signToken({ sub: "U", role: "coordinator" }))).toThrow();
  });

  it("rejects an expired token and garbage", () => {
    process.env.INTERNAL_SERVICE_SECRET = "internal-secret";
    expect(() => verifyInternalToken(signWithClock({ svc: "x" }, "internal-secret", { expiresIn: -1 }))).toThrow(/expired/);
    expect(() => verifyInternalToken("junk")).toThrow();
  });

  it("explains a missing INTERNAL_SERVICE_SECRET", () => {
    process.env.INTERNAL_SERVICE_SECRET = "";
    expect(() => verifyInternalToken("a.b.c")).toThrow(/INTERNAL_SERVICE_SECRET is not set/);
  });
});

describe("sibling-service clients", () => {
  const fetchMock = vi.fn();
  const envKeys = [
    "REGISTRATION_SERVICE_URL",
    "REGISTRATION_SERVICE_PORT",
    "VENUE_SERVICE_URL",
    "VENUE_SERVICE_PORT",
    "EQUIPMENT_SERVICE_URL",
    "EQUIPMENT_SERVICE_PORT",
  ];
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    for (const key of envKeys) delete process.env[key];
  });
  afterEach(() => vi.unstubAllGlobals());

  const ok = (body: unknown) => ({ ok: true, json: async () => body });
  const notOk = { ok: false, json: async () => ({}) };

  describe("fetchEventRegistrations", () => {
    it("maps rows, forwards the token and calls the default URL", async () => {
      fetchMock.mockResolvedValue(
        ok({ registrations: [{ registrationId: 1, userId: "A-1", status: "Registered", name: "Ann", extra: "x" }] }),
      );
      const result = await fetchEventRegistrations(7, "Bearer t");
      expect(result).toEqual({
        status: "ok",
        value: [{ registrationId: 1, userId: "A-1", status: "Registered", name: "Ann" }],
      });
      expect(fetchMock).toHaveBeenCalledWith("http://localhost:4007/api/registrations/event/7", {
        headers: { Authorization: "Bearer t" },
      });
    });

    it("returns an empty list when there is no registrations key", async () => {
      fetchMock.mockResolvedValue(ok({}));
      expect(await fetchEventRegistrations(7, "t")).toEqual({ status: "ok", value: [] });
    });

    it("errors on non-ok, network failure and bad JSON", async () => {
      fetchMock.mockResolvedValueOnce(notOk);
      expect(await fetchEventRegistrations(7, "t")).toEqual({ status: "error" });
      fetchMock.mockRejectedValueOnce(new Error("down"));
      expect(await fetchEventRegistrations(7, "t")).toEqual({ status: "error" });
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => { throw new Error("bad"); } });
      expect(await fetchEventRegistrations(7, "t")).toEqual({ status: "error" });
    });

    it("prefers the URL var, then the port var", async () => {
      fetchMock.mockResolvedValue(ok({}));
      process.env.REGISTRATION_SERVICE_PORT = "9";
      await fetchEventRegistrations(1, "t");
      expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:9/api/registrations/event/1");
      process.env.REGISTRATION_SERVICE_URL = "http://reg";
      await fetchEventRegistrations(1, "t");
      expect(fetchMock.mock.calls[1][0]).toBe("http://reg/api/registrations/event/1");
    });
  });

  describe("fetchEventVenueBookings", () => {
    it("defaults a missing capacity to null and keeps a null venue", async () => {
      fetchMock.mockResolvedValue(
        ok({
          bookings: [
            { id: 1, status: "Approved", venue: { id: 2, name: "Hall" } },
            { id: 2, status: "Approved", venue: { id: 3, name: "Lab", capacity: 0 } },
            { id: 3, status: "Requested", venue: null },
          ],
        }),
      );
      const result = await fetchEventVenueBookings(7, "Bearer t");
      expect(result).toEqual({
        status: "ok",
        value: [
          { id: 1, status: "Approved", venue: { id: 2, name: "Hall", capacity: null } },
          { id: 2, status: "Approved", venue: { id: 3, name: "Lab", capacity: 0 } },
          { id: 3, status: "Requested", venue: null },
        ],
      });
      expect(fetchMock).toHaveBeenCalledWith("http://localhost:4003/api/venues/events/7/bookings", {
        headers: { Authorization: "Bearer t" },
      });
    });

    it("returns an empty list for a body with no bookings and an error for a failure", async () => {
      fetchMock.mockResolvedValueOnce(ok({}));
      expect(await fetchEventVenueBookings(7, "t")).toEqual({ status: "ok", value: [] });
      fetchMock.mockResolvedValueOnce(notOk);
      expect(await fetchEventVenueBookings(7, "t")).toEqual({ status: "error" });
      fetchMock.mockRejectedValueOnce(new Error("down"));
      expect(await fetchEventVenueBookings(7, "t")).toEqual({ status: "error" });
    });

    it("honours VENUE_SERVICE_URL and VENUE_SERVICE_PORT", async () => {
      fetchMock.mockResolvedValue(ok({}));
      process.env.VENUE_SERVICE_PORT = "8";
      await fetchEventVenueBookings(1, "t");
      expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8/api/venues/events/1/bookings");
      process.env.VENUE_SERVICE_URL = "http://venues";
      await fetchEventVenueBookings(1, "t");
      expect(fetchMock.mock.calls[1][0]).toBe("http://venues/api/venues/events/1/bookings");
    });
  });

  describe("fetchEventEquipmentRequests", () => {
    it("drops Cancelled requests and keeps the rest", async () => {
      fetchMock.mockResolvedValue(
        ok({ equipmentRequests: [{ id: 1, status: "Cancelled", items: [] }, { id: 2, status: "Pending", items: [] }] }),
      );
      expect(await fetchEventEquipmentRequests(7, "Bearer t")).toEqual({
        status: "ok",
        value: [{ id: 2, status: "Pending", items: [] }],
      });
      expect(fetchMock).toHaveBeenCalledWith("http://localhost:4005/api/equipment-requests?eventId=7", {
        headers: { Authorization: "Bearer t" },
      });
    });

    it("returns an empty list when absent and an error on failure", async () => {
      fetchMock.mockResolvedValueOnce(ok({}));
      expect(await fetchEventEquipmentRequests(7, "t")).toEqual({ status: "ok", value: [] });
      fetchMock.mockResolvedValueOnce(notOk);
      expect(await fetchEventEquipmentRequests(7, "t")).toEqual({ status: "error" });
    });

    it("honours EQUIPMENT_SERVICE_URL and EQUIPMENT_SERVICE_PORT", async () => {
      fetchMock.mockResolvedValue(ok({}));
      process.env.EQUIPMENT_SERVICE_PORT = "7";
      await fetchEventEquipmentRequests(1, "t");
      expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:7/api/equipment-requests?eventId=1");
      process.env.EQUIPMENT_SERVICE_URL = "http://equip";
      await fetchEventEquipmentRequests(1, "t");
      expect(fetchMock.mock.calls[1][0]).toBe("http://equip/api/equipment-requests?eventId=1");
    });
  });

  describe("flagBookingForRebooking / flagEquipmentForReassessment", () => {
    it("POSTs the reason as JSON with the token and returns the body", async () => {
      fetchMock.mockResolvedValue(ok({ staffNotified: true }));
      expect(await flagBookingForRebooking(5, "Too small", "Bearer t")).toEqual({
        status: "ok",
        value: { staffNotified: true },
      });
      expect(fetchMock).toHaveBeenCalledWith("http://localhost:4003/api/venues/bookings/5/flag-for-rebooking", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
        body: JSON.stringify({ reason: "Too small" }),
      });
    });

    it("POSTs the equipment flag the same way", async () => {
      fetchMock.mockResolvedValue(ok({ flaggedRequestIds: [1], notified: true }));
      expect(await flagEquipmentForReassessment(7, "Changed", "Bearer t")).toEqual({
        status: "ok",
        value: { flaggedRequestIds: [1], notified: true },
      });
      expect(fetchMock).toHaveBeenCalledWith("http://localhost:4005/api/equipment-requests/flag-for-event/7", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
        body: JSON.stringify({ reason: "Changed" }),
      });
    });

    it("errors on non-ok and on network failure for both", async () => {
      fetchMock.mockResolvedValue(notOk);
      expect(await flagBookingForRebooking(5, "r", "t")).toEqual({ status: "error" });
      expect(await flagEquipmentForReassessment(7, "r", "t")).toEqual({ status: "error" });
      fetchMock.mockRejectedValue(new Error("down"));
      expect(await flagBookingForRebooking(5, "r", "t")).toEqual({ status: "error" });
      expect(await flagEquipmentForReassessment(7, "r", "t")).toEqual({ status: "error" });
    });
  });

  describe("checkBookingAvailability", () => {
    it("sends only the times that are set", async () => {
      fetchMock.mockResolvedValue(ok({ available: true }));
      await checkBookingAvailability(5, { proposedDate: "2099-01-01", startTime: "10:00", endTime: "12:00" }, "t");
      expect(fetchMock.mock.calls[0][0]).toBe(
        "http://localhost:4003/api/venues/bookings/5/availability-check?proposedDate=2099-01-01&startTime=10%3A00&endTime=12%3A00",
      );
      await checkBookingAvailability(5, { proposedDate: "2099-01-01", startTime: null, endTime: "" }, "t");
      expect(fetchMock.mock.calls[1][0]).toBe(
        "http://localhost:4003/api/venues/bookings/5/availability-check?proposedDate=2099-01-01",
      );
      await checkBookingAvailability(5, { proposedDate: "2099-01-01", startTime: "09:00", endTime: null }, "t");
      expect(fetchMock.mock.calls[2][0]).toContain("startTime=09%3A00");
      expect(fetchMock.mock.calls[2][0]).not.toContain("endTime");
    });

    it("passes the result through and errors on failure", async () => {
      fetchMock.mockResolvedValueOnce(ok({ available: false, bookingConflict: null, unavailabilityConflict: null }));
      expect(await checkBookingAvailability(5, { proposedDate: "d", startTime: null, endTime: null }, "t")).toEqual({
        status: "ok",
        value: { available: false, bookingConflict: null, unavailabilityConflict: null },
      });
      fetchMock.mockResolvedValueOnce(notOk);
      expect(await checkBookingAvailability(5, { proposedDate: "d", startTime: null, endTime: null }, "t")).toEqual({
        status: "error",
      });
    });
  });
});

describe("diffSubmittedDetails labels", () => {
  const base = { ...VALID, name: "Spring Gala" };

  it("returns null / [] when nothing changed", () => {
    expect(diffSubmittedDetails(base, base)).toBeNull();
    expect(diffSubmittedDetailsStructured(base, base)).toEqual([]);
  });

  it("labels every field and formats booleans as Yes/No", () => {
    const changed = {
      name: "N",
      purpose: "P",
      description: "D",
      proposedDate: "2099-07-01",
      startTime: "11:00",
      endTime: "13:00",
      expectedAttendance: 5,
      venue: "V",
      accessibility: "A",
      equipment: "E",
      technicalSupport: "T",
      registrationNeeded: false,
    };
    expect(diffSubmittedDetails(base, changed)?.split("\n")).toEqual([
      "Event name changed from 'Spring Gala' to 'N'",
      "Purpose changed from 'Fundraiser' to 'P'",
      "Description changed from 'Annual dinner' to 'D'",
      "Proposed date changed from '2099-06-01' to '2099-07-01'",
      "Start time changed from '10:00' to '11:00'",
      "End time changed from '12:00' to '13:00'",
      "Expected attendance changed from '100' to '5'",
      "Venue changed from 'Hall' to 'V'",
      "Accessibility changed from 'Ramp' to 'A'",
      "Equipment changed from 'None' to 'E'",
      "Technical support changed from 'None' to 'T'",
      "Registration needed changed from 'Yes' to 'No'",
    ]);
    expect(diffSubmittedDetailsStructured(base, changed).map((c) => c.field)).toEqual([
      "Event name", "Purpose", "Description", "Proposed date", "Start time", "End time",
      "Expected attendance", "Venue", "Accessibility", "Equipment", "Technical support", "Registration needed",
    ]);
  });

  it("shows a dash / null for a field that had no old value", () => {
    expect(diffSubmittedDetails({}, { ...base })?.split("\n")[0]).toBe("Event name changed from '—' to 'Spring Gala'");
    expect(diffSubmittedDetailsStructured({ name: null as never }, { ...base, name: "X" })[0]).toEqual({
      field: "Event name",
      oldValue: null,
      newValue: "X",
    });
  });

  it("does not treat 0 or false as a missing old value", () => {
    const diff = diffSubmittedDetailsStructured({ ...base, expectedAttendance: 0, registrationNeeded: false }, base);
    expect(diff).toEqual([
      { field: "Expected attendance", oldValue: "0", newValue: "100" },
      { field: "Registration needed", oldValue: "No", newValue: "Yes" },
    ]);
  });
});

describe("reschedule helpers", () => {
  it("scheduleOf trims blanks to null and keeps real values", () => {
    expect(scheduleOf(null)).toEqual({ proposedDate: null, startTime: null, endTime: null });
    expect(scheduleOf(undefined)).toEqual({ proposedDate: null, startTime: null, endTime: null });
    expect(scheduleOf({ proposedDate: " ", startTime: 5, endTime: "12:00" })).toEqual({
      proposedDate: null,
      startTime: null,
      endTime: "12:00",
    });
  });

  it("scheduleChanged counts empty and missing as the same, and any differing field as a change", () => {
    expect(scheduleChanged({ startTime: "" }, {})).toBe(false);
    expect(scheduleChanged(null, undefined)).toBe(false);
    expect(scheduleChanged({ proposedDate: "a" }, { proposedDate: "b" })).toBe(true);
    expect(scheduleChanged({ startTime: "10:00" }, { startTime: "10:01" })).toBe(true);
    expect(scheduleChanged({ endTime: "10:00" }, {})).toBe(true);
    expect(scheduleChanged({ name: "a" }, { name: "b" })).toBe(false);
  });

  it.each([
    [{ expectedAttendance: 10 }, 10],
    [{ expectedAttendance: "10" }, 10],
    [{ expectedAttendance: 0 }, 0],
    [{ expectedAttendance: "" }, null],
    [{ expectedAttendance: "  " }, null],
    [{ expectedAttendance: "abc" }, null],
    [{ expectedAttendance: NaN }, null],
    [{ expectedAttendance: Infinity }, null],
    [{ expectedAttendance: null }, null],
    [{}, null],
    [null, null],
    [undefined, null],
  ])("attendanceOf(%j) is %j", (details, expected) => {
    expect(attendanceOf(details)).toBe(expected);
  });

  it("attendanceChanged compares parsed values, and missing vs present is a change", () => {
    expect(attendanceChanged({ expectedAttendance: "10" }, { expectedAttendance: 10 })).toBe(false);
    expect(attendanceChanged({ expectedAttendance: 10 }, { expectedAttendance: 11 })).toBe(true);
    expect(attendanceChanged({}, { expectedAttendance: 0 })).toBe(true);
    expect(attendanceChanged({}, {})).toBe(false);
  });
});

describe("publishDurably", () => {
  const msg = {
    type: "event.cancelled",
    eventId: 7,
    actorId: "ORG-1",
    recipients: { userIds: ["ORG-1"], roles: ["coordinator"] },
    data: { reason: "x" },
  };
  const stored = {
    id: 3,
    message_id: "m-3",
    type: "event.cancelled",
    event_id: 7,
    actor_id: "ORG-1",
    recipients: msg.recipients,
    data: msg.data,
    occurred_at: "2026-01-01T00:00:00Z",
  };

  function supabaseFor(insertResult: { data: unknown; error: unknown }, updateError: unknown = null) {
    const single = vi.fn().mockResolvedValue(insertResult);
    const select = vi.fn().mockReturnValue({ single });
    const insert = vi.fn().mockReturnValue({ select });
    const eq = vi.fn().mockResolvedValue({ error: updateError });
    const update = vi.fn().mockReturnValue({ eq });
    const from = vi.fn(() => ({ insert, update }));
    return { supabase: { from } as never, from, insert, select, update, eq };
  }

  afterEach(() => {
    setPublisherForTest(undefined);
    vi.restoreAllMocks();
  });

  it("stores the message, publishes the stored row, marks it published and resolves true", async () => {
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });
    const { supabase, from, insert, select, update, eq } = supabaseFor({ data: stored, error: null });

    expect(await publishDurably(supabase, msg)).toBe(true);

    expect(from).toHaveBeenCalledWith("event_outbox");
    expect(insert).toHaveBeenCalledWith({
      type: "event.cancelled",
      event_id: 7,
      actor_id: "ORG-1",
      recipients: msg.recipients,
      data: msg.data,
    });
    expect(select).toHaveBeenCalledWith("id, message_id, type, event_id, actor_id, recipients, data, occurred_at");
    expect(publish).toHaveBeenCalledWith({
      messageId: "m-3",
      occurredAt: "2026-01-01T00:00:00Z",
      type: "event.cancelled",
      eventId: 7,
      actorId: "ORG-1",
      recipients: msg.recipients,
      data: msg.data,
    });
    expect(update).toHaveBeenCalledWith({ published_at: expect.any(String) });
    expect(eq).toHaveBeenCalledWith("id", 3);
  });

  it("leaves the row unpublished for the relay when the broker doesn't confirm, but still resolves true", async () => {
    const publish = vi.fn().mockResolvedValue(false);
    setPublisherForTest({ publish });
    const { supabase, update } = supabaseFor({ data: stored, error: null });

    expect(await publishDurably(supabase, msg)).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ["an insert error", { data: null, error: { message: "boom" } }],
    ["no row back", { data: null, error: null }],
    ["an error alongside data", { data: stored, error: { message: "boom" } }],
  ])("publishes the original message directly after %s", async (_label, result) => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });
    const { supabase, update } = supabaseFor(result);

    expect(await publishDurably(supabase, msg)).toBe(true);
    expect(publish).toHaveBeenCalledWith(msg);
    expect(update).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('"event.cancelled"'), result.error);
  });

  it("resolves false only when it can neither store nor publish", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setPublisherForTest({ publish: vi.fn().mockResolvedValue(false) });
    const { supabase } = supabaseFor({ data: null, error: { message: "boom" } });
    expect(await publishDurably(supabase, msg)).toBe(false);
  });

  it("logs, but doesn't throw, when marking the row published fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    setPublisherForTest({ publish: vi.fn().mockResolvedValue(true) });
    const { supabase } = supabaseFor({ data: stored, error: null }, { message: "nope" });
    expect(await publishDurably(supabase, msg)).toBe(true);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("outbox row 3"), { message: "nope" });
  });
});

describe("validateEventRequest — every text field is trimmed", () => {
  it("trims all seven free-text fields, not just the name", () => {
    const padded = Object.fromEntries(TEXT_FIELDS.map((f) => [f, `  ${f}  `]));
    const value = validateEventRequest({ ...VALID, ...padded }).value as unknown as Record<string, unknown>;
    for (const field of TEXT_FIELDS) expect(value[field]).toBe(field);
  });
});

const NOTE = "x";
const longNote = (n: number) => "y".repeat(n);

describe("parseSafetyNotes", () => {
  const goodNotes = {
    equipmentPlacement: "Away from exits",
    crowdMovement: "One-way",
    emergencyAccess: "Clear",
    venueRestrictions: "None known",
  };

  it("accepts four trimmed notes", () => {
    const result = parseSafetyNotes({ safetyNotes: Object.fromEntries(Object.entries(goodNotes).map(([k, v]) => [k, ` ${v} `])) });
    expect(result).toEqual({ valid: true, notes: goodNotes });
  });

  it("accepts a note of exactly the maximum length and rejects one character more", () => {
    const at = parseSafetyNotes({ safetyNotes: { ...goodNotes, crowdMovement: longNote(MAX_SAFETY_NOTE_LENGTH) } });
    expect(at.valid).toBe(true);
    const over = parseSafetyNotes({ safetyNotes: { ...goodNotes, crowdMovement: longNote(MAX_SAFETY_NOTE_LENGTH + 1) } });
    expect(over).toEqual({ valid: false, fields: { crowdMovement: "Keep this under 2000 characters." } });
  });

  it("measures the length after trimming", () => {
    const padded = ` ${longNote(MAX_SAFETY_NOTE_LENGTH)} `;
    expect(parseSafetyNotes({ safetyNotes: { ...goodNotes, emergencyAccess: padded } }).valid).toBe(true);
  });

  it.each([undefined, null, "", "   ", 5, {}, []])("treats %j as missing and names every field", (blank) => {
    const result = parseSafetyNotes({ safetyNotes: { ...goodNotes, equipmentPlacement: blank, venueRestrictions: blank } });
    expect(result).toEqual({
      valid: false,
      fields: {
        equipmentPlacement: "Describe the equipment placement.",
        venueRestrictions: 'Describe any known venue restrictions, or write "None known".',
      },
    });
  });

  it.each([undefined, null, "str", 5, [], {}])("reports all four fields for a body of %j", (body) => {
    const result = parseSafetyNotes(body === undefined ? undefined : { safetyNotes: body });
    expect(result.valid).toBe(false);
    expect(Object.keys((result as { fields: object }).fields)).toEqual([
      "equipmentPlacement",
      "crowdMovement",
      "emergencyAccess",
      "venueRestrictions",
    ]);
  });
});

describe("equipmentIsRequired", () => {
  it.each([
    null, undefined, "", "  ", "NA", "N/A", "n.a.", "None", "none.", "Nil", "Nothing", "No", "Not applicable",
    "Not required", "None required", "No equipment needed", "NONE!!!", "  none  ", "No requirements", "nil needs",
  ])("%j means no equipment", (text) => {
    expect(equipmentIsRequired(text)).toBe(false);
  });

  it.each([
    "2 microphones", "None of the usual, but 2 mics", "Projector", "nonexistent", "Nap room", "not required but a projector",
    "none required please", "0", "N/A and a mic",
  ])("%j asks for equipment", (text) => {
    expect(equipmentIsRequired(text)).toBe(true);
  });
});

describe("findOutstandingArrangements / describeOutstanding", () => {
  const booking = (id: number, status: string, name: string | null = "Hall") =>
    ({ id, status, venue: name === null ? null : { id: 1, name, capacity: 10 } }) as never;
  const request = (id: number, items: { id: number; q: number; f: number }[], status = "Pending") =>
    ({
      id,
      status,
      items: items.map((i) => ({ id: i.id, equipmentType: "Mic", quantity: i.q, quantityFulfilled: i.f })),
    }) as never;

  it("is clear when a venue is approved and nothing else is pending", () => {
    const result = findOutstandingArrangements([booking(1, "Approved")], [], "None");
    expect(result).toEqual({ noApprovedVenue: false, bookings: [], equipment: [], equipmentNotArranged: null });
    expect(hasOutstanding(result)).toBe(false);
  });

  it("flags no approved venue for an empty list and for only-settled-but-unapproved bookings", () => {
    expect(findOutstandingArrangements([], [], "None").noApprovedVenue).toBe(true);
    expect(findOutstandingArrangements([booking(1, "Rejected"), booking(2, "Withdrawn"), booking(3, "Expired")], [], "").noApprovedVenue).toBe(true);
  });

  it.each(["Requested", "On Hold", "Replacement Required"])("%s blocks, with the venue name or null", (status) => {
    const result = findOutstandingArrangements([booking(1, "Approved"), booking(2, status), booking(3, status, null)], [], "");
    expect(result.bookings).toEqual([
      { bookingId: 2, venueName: "Hall", status },
      { bookingId: 3, venueName: null, status },
    ]);
    expect(hasOutstanding(result)).toBe(true);
  });

  it.each(["Rejected", "Withdrawn", "Expired", "Cancelled"])("%s does not block when another booking is approved", (status) => {
    expect(findOutstandingArrangements([booking(1, "Approved"), booking(2, status)], [], "").bookings).toEqual([]);
  });

  it("an equipment item blocks until its full quantity is fulfilled", () => {
    const partly = findOutstandingArrangements([booking(1, "Approved")], [request(9, [{ id: 1, q: 2, f: 1 }])], "");
    expect(partly.equipment).toEqual([{ requestId: 9, equipmentType: "Mic", quantity: 2, quantityReserved: 1 }]);
    const none = findOutstandingArrangements([booking(1, "Approved")], [request(9, [{ id: 1, q: 1, f: 0 }])], "");
    expect(none.equipment).toHaveLength(1);
    const full = findOutstandingArrangements([booking(1, "Approved")], [request(9, [{ id: 1, q: 2, f: 2 }])], "");
    expect(full.equipment).toEqual([]);
    const over = findOutstandingArrangements([booking(1, "Approved")], [request(9, [{ id: 1, q: 2, f: 3 }])], "");
    expect(over.equipment).toEqual([]);
  });

  it("asked-for equipment with no recorded request is outstanding (trimmed text), but not once an item exists", () => {
    const missing = findOutstandingArrangements([booking(1, "Approved")], [], "  2 mics  ");
    expect(missing.equipmentNotArranged).toBe("2 mics");
    expect(hasOutstanding(missing)).toBe(true);
    const recorded = findOutstandingArrangements([booking(1, "Approved")], [request(1, [{ id: 1, q: 1, f: 1 }])], "2 mics");
    expect(recorded.equipmentNotArranged).toBeNull();
  });

  it("a cancelled request doesn't count as a recorded one", () => {
    const result = findOutstandingArrangements([booking(1, "Approved")], [request(1, [{ id: 1, q: 1, f: 1 }], "Cancelled")], "2 mics");
    expect(result.equipmentNotArranged).toBe("2 mics");
  });

  it("an undefined requirement is not 'asked for' and an empty request with no items records nothing", () => {
    expect(findOutstandingArrangements([booking(1, "Approved")], [], undefined).equipmentNotArranged).toBeNull();
    expect(findOutstandingArrangements([booking(1, "Approved")], [request(1, [])], "2 mics").equipmentNotArranged).toBe("2 mics");
  });

  it("hasOutstanding is true for each single kind on its own", () => {
    const base = { noApprovedVenue: false, bookings: [], equipment: [], equipmentNotArranged: null };
    expect(hasOutstanding(base)).toBe(false);
    expect(hasOutstanding({ ...base, noApprovedVenue: true })).toBe(true);
    expect(hasOutstanding({ ...base, bookings: [{ bookingId: 1, venueName: null, status: "x" }] })).toBe(true);
    expect(hasOutstanding({ ...base, equipment: [{ requestId: 1, equipmentType: "a", quantity: 1, quantityReserved: 0 }] })).toBe(true);
    expect(hasOutstanding({ ...base, equipmentNotArranged: "" })).toBe(true);
  });

  it("describes every outstanding item in one sentence", () => {
    const sentence = describeOutstanding({
      noApprovedVenue: true,
      bookings: [
        { bookingId: 4, venueName: "Grand Ballroom", status: "On Hold" },
        { bookingId: 5, venueName: null, status: "Requested" },
      ],
      equipment: [{ requestId: 1, equipmentType: "Projector", quantity: 2, quantityReserved: 1 }],
      equipmentNotArranged: "2 mics",
    });
    expect(sentence).toBe(
      "This event can't be submitted for safety review yet. Settle these first: the event has no approved venue booking; " +
        "Grand Ballroom is still On Hold; Venue booking #5 is still Requested; Projector: 1 of 2 reserved; " +
        "the requested equipment (2 mics) hasn't been arranged yet.",
    );
  });

  it("describes a single item without separators", () => {
    expect(describeOutstanding({ noApprovedVenue: false, bookings: [], equipment: [], equipmentNotArranged: "" })).toBe(
      "This event can't be submitted for safety review yet. Settle these first: the requested equipment () hasn't been arranged yet.",
    );
  });
});

describe("parseChangeRequest", () => {
  const pick = (type: string, id: unknown, ...rest: [unknown?]) => ({ type, id, note: rest.length ? rest[0] : NOTE });

  it("accepts picked arrangements with trimmed notes and a null general note by default", () => {
    expect(parseChangeRequest({ arrangements: [pick("venue_booking", 1, "  exits  "), pick("equipment_item", 2)] })).toEqual({
      valid: true,
      request: {
        arrangements: [
          { type: "venue_booking", id: 1, note: "exits" },
          { type: "equipment_item", id: 2, note: NOTE },
        ],
        generalNote: null,
      },
    });
  });

  it("keeps a trimmed general note and drops a blank one", () => {
    const withNote = parseChangeRequest({ arrangements: [pick("venue_booking", 1)], generalNote: "  update plan " });
    expect(withNote).toMatchObject({ valid: true, request: { generalNote: "update plan" } });
    const blank = parseChangeRequest({ arrangements: [pick("venue_booking", 1)], generalNote: "   " });
    expect(blank).toMatchObject({ valid: true, request: { generalNote: null } });
  });

  it("requires at least one arrangement", () => {
    for (const body of [undefined, null, "x", {}, { arrangements: [] }, { arrangements: "nope" }]) {
      expect(parseChangeRequest(body)).toEqual({
        valid: false,
        fields: { arrangements: "Select at least one venue booking or equipment reservation that must change." },
      });
    }
  });

  it.each([
    pick("room", 1),
    pick("venue_booking", 0),
    pick("venue_booking", -3),
    pick("venue_booking", 1.5),
    pick("venue_booking", "1"),
    pick("venue_booking", null),
    pick("", 1),
    null,
    "x",
    7,
  ])("rejects the malformed entry %j", (entry) => {
    const result = parseChangeRequest({ arrangements: [entry, pick("venue_booking", 9)] });
    expect(result).toEqual({
      valid: false,
      fields: { arrangements: "Each arrangement needs a type (venue_booking or equipment_item) and an id." },
    });
  });

  it("accepts id 1 as the smallest valid id", () => {
    expect(parseChangeRequest({ arrangements: [pick("venue_booking", 1)] }).valid).toBe(true);
  });

  it("de-duplicates the same arrangement but keeps the same id across types", () => {
    const result = parseChangeRequest({
      arrangements: [pick("venue_booking", 1, "first"), pick("venue_booking", 1, "second"), pick("equipment_item", 1, "third")],
    });
    expect(result).toMatchObject({
      valid: true,
      request: {
        arrangements: [
          { type: "venue_booking", id: 1, note: "first" },
          { type: "equipment_item", id: 1, note: "third" },
        ],
      },
    });
  });

  it.each([undefined, null, "", "   ", 5, {}])("requires a note per arrangement (%j)", (note) => {
    expect(parseChangeRequest({ arrangements: [pick("venue_booking", 3, note)] })).toEqual({
      valid: false,
      fields: { "note:venue_booking:3": "Say what must change here." },
    });
  });

  it("accepts a note of exactly the maximum length and rejects one more", () => {
    expect(parseChangeRequest({ arrangements: [pick("venue_booking", 1, longNote(MAX_SAFETY_CHANGE_NOTE_LENGTH))] }).valid).toBe(true);
    expect(parseChangeRequest({ arrangements: [pick("venue_booking", 1, longNote(MAX_SAFETY_CHANGE_NOTE_LENGTH + 1))] })).toEqual({
      valid: false,
      fields: { "note:venue_booking:1": `Keep this under ${MAX_SAFETY_CHANGE_NOTE_LENGTH} characters.` },
    });
  });

  it("applies the same length boundary to the general note", () => {
    const base = { arrangements: [pick("venue_booking", 1)] };
    expect(parseChangeRequest({ ...base, generalNote: longNote(MAX_SAFETY_CHANGE_NOTE_LENGTH) }).valid).toBe(true);
    expect(parseChangeRequest({ ...base, generalNote: longNote(MAX_SAFETY_CHANGE_NOTE_LENGTH + 1) })).toEqual({
      valid: false,
      fields: { generalNote: `Keep this under ${MAX_SAFETY_CHANGE_NOTE_LENGTH} characters.` },
    });
  });

  it("ignores a non-string general note", () => {
    expect(parseChangeRequest({ arrangements: [pick("venue_booking", 1)], generalNote: 5 })).toMatchObject({
      valid: true,
      request: { generalNote: null },
    });
  });
});

describe("currentArrangements / resolveFlags / combinedReason", () => {
  const bookings = [
    { id: 1, status: "Approved", venue: { id: 1, name: "Hall", capacity: 10 } },
    { id: 2, status: "Rejected", venue: null },
    { id: 3, status: "Withdrawn", venue: { id: 2, name: "Lab", capacity: 5 } },
    { id: 4, status: "Expired", venue: null },
    { id: 5, status: "On Hold", venue: null },
  ] as never;
  const requests = [
    { id: 1, status: "Pending", items: [{ id: 7, equipmentType: "Mic", quantity: 2, quantityFulfilled: 1 }] },
  ] as never;

  it("describes each arrangement and marks ended bookings as not flaggable", () => {
    const states = currentArrangements(bookings, requests);
    expect([...states.keys()]).toEqual(["venue_booking:1", "venue_booking:2", "venue_booking:3", "venue_booking:4", "venue_booking:5", "equipment_item:7"]);
    expect(states.get("venue_booking:1")).toEqual({
      option: { type: "venue_booking", id: 1, label: "Hall", detail: "Approved" },
      snapshot: { status: "Approved" },
      flaggable: true,
    });
    expect(states.get("venue_booking:5")?.option.label).toBe("Venue booking #5");
    for (const id of [2, 3, 4]) expect(states.get(`venue_booking:${id}`)?.flaggable).toBe(false);
    expect(states.get("equipment_item:7")).toEqual({
      option: { type: "equipment_item", id: 7, label: "Mic × 2", detail: "1 of 2 reserved" },
      snapshot: { equipmentType: "Mic", quantity: 2, quantityFulfilled: 1 },
      flaggable: true,
    });
  });

  it("arrangementOptions lists only the flaggable ones", () => {
    expect(arrangementOptions(bookings, requests).map((o) => `${o.type}:${o.id}`)).toEqual([
      "venue_booking:1",
      "venue_booking:5",
      "equipment_item:7",
    ]);
  });

  it("resolveFlags turns live picks into flags carrying label, note and snapshot", () => {
    expect(resolveFlags([{ type: "venue_booking", id: 1, note: "n" }], bookings, requests)).toEqual({
      ok: true,
      flags: [{ type: "venue_booking", id: 1, label: "Hall", note: "n", snapshot: { status: "Approved" } }],
    });
  });

  it("resolveFlags names every pick that is unknown or not flaggable, and returns no flags", () => {
    const picks = [
      { type: "venue_booking" as const, id: 1, note: "ok" },
      { type: "venue_booking" as const, id: 2, note: "ended" },
      { type: "equipment_item" as const, id: 99, note: "missing" },
      { type: "equipment_item" as const, id: 1, note: "wrong type for id" },
    ];
    expect(resolveFlags(picks, bookings, requests)).toEqual({ ok: false, unknown: picks.slice(1) });
  });

  it("combinedReason joins labelled notes, strips trailing punctuation and appends the general note", () => {
    const flags = [
      { label: "Hall", note: "exits blocked." },
      { label: "Mic × 2", note: "move away;  " },
      { label: "Lab", note: "no punctuation" },
    ];
    expect(combinedReason(flags, null)).toBe("Hall: exits blocked; Mic × 2: move away; Lab: no punctuation");
    expect(combinedReason(flags.slice(0, 1), "update the plan")).toBe("Hall: exits blocked. General: update the plan");
    expect(combinedReason([{ label: "A", note: "x..;; ." }], "")).toBe("A: x");
  });
});

describe("remaining lib branches", () => {
  it("eventStartsAt returns null for a date that matches the pattern but doesn't exist", () => {
    expect(eventStartsAt({ proposedDate: "2026-13-45", startTime: "10:00" })).toBeNull();
    expect(eventStartsAt({ proposedDate: "2026-02-30", startTime: "10:00" })?.toISOString()).toBeDefined();
  });

  it("registrationCutoff is null without a readable date and 5 days before the start otherwise", async () => {
    const { registrationCutoff } = await import("../lib/registrationPeriod.js");
    expect(registrationCutoff({})).toBeNull();
    expect(registrationCutoff({ proposedDate: "2026-11-20", startTime: "10:00" })?.toISOString()).toBe("2026-11-15T02:00:00.000Z");
  });

  it("the secrets are read lazily and a missing one is reported", () => {
    const saved = { j: process.env.JWT_SECRET, i: process.env.INTERNAL_SERVICE_SECRET };
    delete process.env.JWT_SECRET;
    delete process.env.INTERNAL_SERVICE_SECRET;
    expect(() => signToken({ sub: "U", role: "r" })).toThrow(/JWT_SECRET is not set/);
    expect(() => verifyInternalToken("a.b.c")).toThrow(/INTERNAL_SERVICE_SECRET is not set/);
    process.env.JWT_SECRET = saved.j;
    process.env.INTERNAL_SERVICE_SECRET = saved.i;
  });

  it("hasChanged treats a flag with no snapshot as 'nothing recorded', so any current state differs", async () => {
    const { hasChanged } = await import("../lib/safetyChanges.js");
    const states = currentArrangements([{ id: 1, status: "Approved", venue: null }] as never, []);
    expect(hasChanged({ arrangement_type: "venue_booking", arrangement_id: 1, snapshot: null } as never, states)).toBe(true);
    expect(hasChanged({ arrangement_type: "venue_booking", arrangement_id: 1, snapshot: { status: "Approved" } } as never, states)).toBe(false);
    expect(hasChanged({ arrangement_type: "venue_booking", arrangement_id: 2, snapshot: { status: "Approved" } } as never, states)).toBe(true);
  });
});

describe("outbox — remaining branches", () => {
  const err = () => vi.spyOn(console, "error").mockImplementation(() => {});

  afterEach(() => {
    vi.useRealTimers();
    setPublisherForTest(undefined);
  });

  it("flushOutbox treats a null data result as nothing waiting", async () => {
    const { flushOutbox } = await import("../lib/outbox.js");
    const limit = vi.fn().mockResolvedValue({ data: null, error: null });
    const supabase = { from: () => ({ select: () => ({ is: () => ({ order: () => ({ limit }) }) }) }) } as never;
    expect(await flushOutbox(supabase)).toBe(0);
  });

  it("flushOutbox logs, but carries on, when recording a failed attempt fails", async () => {
    const { flushOutbox } = await import("../lib/outbox.js");
    const spy = err();
    setPublisherForTest({ publish: vi.fn().mockResolvedValue(false) });
    const row = { id: 4, message_id: "m", type: "t", event_id: 1, actor_id: null, recipients: { userIds: [], roles: [] }, data: {}, occurred_at: "x", attempts: 0 };
    const supabase = {
      from: () => ({
        select: () => ({ is: () => ({ order: () => ({ limit: async () => ({ data: [row], error: null }) }) }) }),
        update: () => ({ eq: async () => ({ error: { message: "no" } }) }),
      }),
    } as never;
    expect(await flushOutbox(supabase)).toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("outbox row 4"), { message: "no" });
  });

  it("startOutboxRelay flushes on a timer, logs a failed run, and stops when told to", async () => {
    vi.useFakeTimers();
    const spy = err();
    const { startOutboxRelay } = await import("../lib/outbox.js");
    let reads = 0;
    const supabase = {
      from: () => ({
        select: () => ({
          is: () => ({
            order: () => ({
              limit: async () => {
                reads += 1;
                if (reads === 1) throw new Error("db down");
                return { data: [], error: null };
              },
            }),
          }),
        }),
      }),
    } as never;

    const stop = startOutboxRelay(supabase, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spy).toHaveBeenCalledWith("events-service: outbox relay failed", expect.any(Error));
    await vi.advanceTimersByTimeAsync(1000);
    expect(reads).toBe(2);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(2);
  });

  it("startOutboxRelay defaults to a ten-second interval", async () => {
    vi.useFakeTimers();
    const { startOutboxRelay } = await import("../lib/outbox.js");
    let reads = 0;
    const supabase = { from: () => ({ select: () => ({ is: () => ({ order: () => ({ limit: async () => { reads += 1; return { data: [], error: null }; } }) }) }) }) } as never;
    const stop = startOutboxRelay(supabase);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(reads).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(1);
    stop();
  });

  it("flushOutbox's findOutstanding hoist keeps a null requirement reading as nothing requested", () => {
    expect(findOutstandingArrangements([{ id: 1, status: "Approved", venue: null }] as never, [], null).equipmentNotArranged).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Mutation killers: each case below exists because a specific mutant used to survive.
// ---------------------------------------------------------------------------------------------

describe("eventTiming — values the Date parser alone would let through", () => {
  const looksLikeADate = { toString: () => "2026-11-10" };
  const looksLikeATime = { toString: () => "10:00" };

  it.each(["2026-11", "2026", "2026-11-10x", "x2026-11-10", " 2026-11-10", ["2026-11-10"], looksLikeADate])(
    "rejects the date %j",
    (date) => {
      expect(eventStartsAt({ proposedDate: date, startTime: "10:00" })).toBeNull();
      expect(eventEndsAt({ proposedDate: date, endTime: "10:00" })).toBeNull();
      expect(localDateStart(date)).toBeNull();
      expect(hasEventStarted({ proposedDate: date, startTime: "10:00" }, new Date("2099-01-01"))).toBe(false);
      expect(hasEventEnded({ proposedDate: date, endTime: "10:00" }, new Date("2099-01-01"))).toBe(false);
    },
  );

  it.each(["24:00", "10", "10:00x", "x10:00", "10:60", ["10:00"], looksLikeATime])("rejects the time %j", (time) => {
    expect(eventStartsAt({ proposedDate: "2026-11-10", startTime: time })).toBeNull();
    expect(eventEndsAt({ proposedDate: "2026-11-10", endTime: time })).toBeNull();
  });

  it.each(["+092026-11-10", "-022026-11-10", "+232026-02-28"])(
    "rejects the extended-year date %j (the date pattern must stay anchored at the start)",
    (date) => {
      expect(eventStartsAt({ proposedDate: date, startTime: "10:00" })).toBeNull();
      expect(eventEndsAt({ proposedDate: date, endTime: "10:00" })).toBeNull();
      expect(localDateStart(date)).toBeNull();
    },
  );

  // Run in Singapore's own zone this proves nothing about the zone-independence, so it steps aside there.
  it.skipIf(process.env.TZ === "Asia/Singapore")("reads the offset as +08:00 whatever zone the process runs in", () => {
    expect(eventStartsAt({ proposedDate: "2026-11-10", startTime: "10:00" })?.toISOString()).toBe("2026-11-10T02:00:00.000Z");
    expect(eventEndsAt({ proposedDate: "2026-11-10", endTime: "10:00" })?.toISOString()).toBe("2026-11-10T02:00:00.000Z");
    expect(localDateStart("2026-11-10")?.toISOString()).toBe("2026-11-09T16:00:00.000Z");
  });
});

describe("changeRequestFields — remaining mutants", () => {
  const base: Partial<ValidatedEventRequest> = { venue: "Hall", startTime: "10:00", endTime: "12:00", proposedDate: "2099-01-01" };

  it("committedFieldValue is null for a null or missing value, never the text 'null'", () => {
    expect(committedFieldValue({ venue: null as never }, "venue")).toBeNull();
    expect(committedFieldValue({}, "venue")).toBeNull();
  });

  it("reports a null oldValue for a null or missing committed value", () => {
    expect(validateChangeRequestFields({ venue: "X" }, { venue: null as never }).changes[0].oldValue).toBeNull();
    expect(validateChangeRequestFields({ venue: "X" }, {}).changes[0].oldValue).toBeNull();
  });

  it("a missing old value never counts as equal to a new value, whatever its text", () => {
    expect(validateChangeRequestFields({ venue: "Stryker was here!" }, {}).changes).toHaveLength(1);
    expect(validateChangeRequestFields({ venue: "undefined" }, {}).changes).toHaveLength(1);
    expect(validateChangeRequestFields({ venue: "null" }, { venue: null as never }).changes).toHaveLength(1);
  });

  it("only compares the times when a time is part of the request", () => {
    const backwards = { ...base, startTime: "12:00", endTime: "10:00" };
    expect(validateChangeRequestFields({ venue: "Other" }, backwards).valid).toBe(true);
    expect(validateChangeRequestFields({ endTime: "10:00" }, backwards).valid).toBe(false);
    expect(validateChangeRequestFields({ startTime: "12:00" }, backwards).valid).toBe(false);
  });

  it.each(["12:00pm", "x10:00", "10:00 ", " 10:00", "10:00x"])("rejects the time %j for both start and end", (time) => {
    expect(validateChangeRequestFields({ startTime: time }, base).fields.startTime).toBe("Enter a valid time.");
    expect(validateChangeRequestFields({ endTime: time }, base).fields.endTime).toBe("Enter a valid time.");
  });
});

describe("jwt — expiry message", () => {
  it("names the problem", () => {
    const token = signWithClock({ sub: "U", role: "r" }, SECRET, { expiresIn: -1 });
    expect(() => verifyToken(token)).toThrow("Token expired");
    try {
      verifyToken(token);
    } catch (err) {
      expect(err).toBeInstanceOf(TokenExpiredError);
      expect((err as Error).message).toBe("Token expired");
    }
  });
});

describe("registrationPeriod — remaining mutants", () => {
  const details = { registrationNeeded: true, proposedDate: "2099-06-01", startTime: "10:00", endTime: "12:00" };
  const input = { status: "Confirmed", details, openDate: "2099-01-01", override: "NONE" };
  const now = new Date("2099-03-01T00:00:00Z");
  const endsAt = eventEndsAt(details)!;

  it("parseOverride only lets the two real overrides through", () => {
    expect(parseOverride("FORCE_OPEN")).toBe("FORCE_OPEN");
    expect(parseOverride("FORCE_CLOSED")).toBe("FORCE_CLOSED");
    for (const other of ["NONE", "bogus", "force_open", "", null, undefined, 5, {}]) expect(parseOverride(other)).toBe("NONE");
  });

  it("is OPEN with no fullness figures, and FULL only when a real capacity is reached", () => {
    expect(getRegistrationState(input, now)).toBe("OPEN");
    expect(getRegistrationState(input, now, { registeredCount: 5, capacity: null })).toBe("OPEN");
    expect(getRegistrationState(input, now, { registeredCount: 4, capacity: 5 })).toBe("OPEN");
    expect(getRegistrationState(input, now, { registeredCount: 5, capacity: 5 })).toBe("FULL");
    expect(getRegistrationState(input, now, { registeredCount: 6, capacity: 5 })).toBe("FULL");
  });

  it("copes with an event whose end is readable but whose start is not", () => {
    const noStart = { ...input, details: { ...details, startTime: "nonsense" } };
    expect(getRegistrationState(noStart, now)).toBe("OPEN");
    expect(getRegistrationState({ ...noStart, openDate: "2099-12-01" }, now)).toBe("NOT_OPEN");
  });

  it("is closed and unlisted, without throwing, for an event with no readable date", () => {
    const noDate = { ...input, details: { registrationNeeded: true } };
    expect(getRegistrationState(noDate, now)).toBe("CLOSED");
    expect(isListed(noDate, now)).toBe(false);
    expect(isListed({ ...noDate, override: "FORCE_OPEN" }, now)).toBe(false);
  });

  it("an event takes registration right up to, but not at, the moment it ends", () => {
    const forced = { ...input, override: "FORCE_OPEN" };
    expect(isListed(forced, new Date(endsAt.getTime() - 1))).toBe(true);
    expect(isListed(forced, endsAt)).toBe(false);
    expect(isListed(forced, new Date(endsAt.getTime() + 1))).toBe(false);
  });

  it("registration is not offered unless the event asks for it", () => {
    for (const registrationNeeded of [false, undefined, "true", 1]) {
      const unneeded = { ...input, details: { ...details, registrationNeeded } };
      expect(getRegistrationState(unneeded as never, now)).toBe("CLOSED");
      expect(isListed(unneeded as never, now)).toBe(false);
    }
  });
});

describe("reschedule announcements — failure is logged and reported", () => {
  const event = { id: 7, actorId: "ORG-1", eventName: "Gala", coordinatorId: "C-1", details: { proposedDate: "2099-01-01", expectedAttendance: 5 } };
  const exploding = { from: () => { throw new Error("db down"); } } as never;

  it("announceReschedule", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await announceReschedule(exploding, event)).toBe(false);
    expect(spy).toHaveBeenCalledWith("events-service: could not announce the reschedule of event 7", expect.any(Error));
  });

  it("announceAttendanceChange", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await announceAttendanceChange(exploding, event)).toBe(false);
    expect(spy).toHaveBeenCalledWith("events-service: could not announce the attendance change of event 7", expect.any(Error));
  });
});

describe("outbox — exact database calls and logging", () => {
  const row = (id: number, attempts = 0) => ({
    id, message_id: `m-${id}`, type: "t", event_id: 1, actor_id: null, recipients: { userIds: [], roles: [] }, data: {}, occurred_at: "x", attempts,
  });

  function db(rows: unknown[], options: { readError?: unknown; updateError?: unknown } = {}) {
    const limit = vi.fn().mockResolvedValue({ data: rows, error: options.readError ?? null });
    const order = vi.fn().mockReturnValue({ limit });
    const is = vi.fn().mockReturnValue({ order });
    const select = vi.fn().mockReturnValue({ is });
    const eq = vi.fn().mockResolvedValue({ error: options.updateError ?? null });
    const update = vi.fn().mockReturnValue({ eq });
    const from = vi.fn(() => ({ select, update }));
    return { supabase: { from } as never, from, select, is, order, limit, update, eq };
  }

  afterEach(() => setPublisherForTest(undefined));

  it("reads the unpublished rows oldest first, 50 at a time, from event_outbox", async () => {
    setPublisherForTest({ publish: vi.fn() });
    const { supabase, from, select, is, order, limit } = db([]);
    await flushOutbox(supabase);
    expect(from).toHaveBeenCalledExactlyOnceWith("event_outbox");
    expect(select).toHaveBeenCalledExactlyOnceWith("id, message_id, type, event_id, actor_id, recipients, data, occurred_at, attempts");
    expect(is).toHaveBeenCalledExactlyOnceWith("published_at", null);
    expect(order).toHaveBeenCalledExactlyOnceWith("id", { ascending: true });
    expect(limit).toHaveBeenCalledExactlyOnceWith(50);
  });

  it("logs a read failure and says nothing on success", async () => {
    setPublisherForTest({ publish: vi.fn() });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await flushOutbox(db([]).supabase);
    expect(spy).not.toHaveBeenCalled();
    await flushOutbox(db([], { readError: { message: "x" } }).supabase);
    expect(spy).toHaveBeenCalledExactlyOnceWith("events-service: could not read the outbox", { message: "x" });
  });

  it("does not use rows returned alongside a read error", async () => {
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await flushOutbox(db([row(1)], { readError: { message: "x" } }).supabase)).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("records a failed attempt on the right table and row, with a reason, logging only if that write fails", async () => {
    setPublisherForTest({ publish: vi.fn().mockResolvedValue(false) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = db([row(4, 2)]);
    await flushOutbox(ok.supabase);
    expect(ok.from).toHaveBeenLastCalledWith("event_outbox");
    expect(ok.update).toHaveBeenCalledExactlyOnceWith({ attempts: 3, last_error: "broker did not confirm the message" });
    expect(ok.eq).toHaveBeenCalledExactlyOnceWith("id", 4);
    expect(spy).not.toHaveBeenCalled();
  });

  it("marks a published row on the right table, logging only if that write fails", async () => {
    setPublisherForTest({ publish: vi.fn().mockResolvedValue(true) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = db([row(5)]);
    expect(await flushOutbox(ok.supabase)).toBe(1);
    expect(ok.from).toHaveBeenLastCalledWith("event_outbox");
    expect(ok.update).toHaveBeenCalledExactlyOnceWith({ published_at: expect.any(String) });
    expect(ok.eq).toHaveBeenCalledExactlyOnceWith("id", 5);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("safetyReview / validateEventRequest — remaining mutants", () => {
  it("treats punctuation runs between words as one separator", () => {
    expect(equipmentIsRequired("None -- required")).toBe(false);
    expect(equipmentIsRequired("No,  equipment!!  needed")).toBe(false);
    expect(equipmentIsRequired("n/a")).toBe(false);
  });

  it.each(["no requirement", "no requirements", "none need", "none needs", "nil requirement needed"])("%j means no equipment", (text) => {
    expect(equipmentIsRequired(text)).toBe(false);
  });

  it.each(["no requirementss", "none needss", "no need s", "none requirement s"])("%j still asks for equipment", (text) => {
    expect(equipmentIsRequired(text)).toBe(true);
  });

  it("describeOutstanding only mentions equipment that was asked for and not arranged", () => {
    const sentence = describeOutstanding({
      noApprovedVenue: false,
      bookings: [{ bookingId: 1, venueName: "Hall", status: "On Hold" }],
      equipment: [],
      equipmentNotArranged: null,
    });
    expect(sentence).toBe("This event can't be submitted for safety review yet. Settle these first: Hall is still On Hold.");
    expect(sentence).not.toMatch(/null|requested equipment/);
  });

  it.each([null, "str", 5, true, [], undefined])("parseSafetyNotes(%j) reports all four notes missing", (body) => {
    const result = parseSafetyNotes(body);
    expect(result.valid).toBe(false);
    expect(Object.keys((result as { fields: object }).fields)).toHaveLength(4);
  });

  it.each(["str", 5, true, [], null])("parseSafetyNotes ignores a safetyNotes of %j", (safetyNotes) => {
    expect(parseSafetyNotes({ safetyNotes }).valid).toBe(false);
  });

  it("names each missing note in its own words", () => {
    expect((parseSafetyNotes({}) as { fields: Record<string, string> }).fields).toEqual({
      equipmentPlacement: "Describe the equipment placement.",
      crowdMovement: "Describe the crowd movement.",
      emergencyAccess: "Describe the emergency access.",
      venueRestrictions: 'Describe any known venue restrictions, or write "None known".',
    });
  });

  it("validateEventRequest says why the proposed date is wrong", () => {
    expect(validateEventRequest({ ...VALID, proposedDate: undefined }).fields.proposedDate).toBe("This field is required.");
    expect(validateEventRequest({ ...VALID, proposedDate: "  " }).fields.proposedDate).toBe("This field is required.");
    expect(validateEventRequest({ ...VALID, proposedDate: "nope" }).fields.proposedDate).toBe("Enter a valid date.");
    expect(validateEventRequest({ ...VALID, proposedDate: "2000-01-01" }).fields.proposedDate).toBe("The proposed date cannot be in the past.");
  });
});

describe("middleware — internal and expired-session answers", () => {
  const INTERNAL = "internal-secret";
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = INTERNAL;
  });

  function runWith(middleware: typeof requireInternal, headers: Record<string, unknown>) {
    const req = { headers } as unknown as AuthedRequest;
    const res = mockRes();
    const next = vi.fn();
    middleware(req, res, next);
    return { req, res, next };
  }

  it("requireAuth tells an expired session apart, in words a person can act on", () => {
    const { res } = run(`Bearer ${signWithClock({ sub: "U", role: "r" }, SECRET, { expiresIn: -1 })}`);
    expect(res.json).toHaveBeenCalledWith({ error: "Your session has expired. Please log in again.", code: "token_expired" });
  });

  describe("requireInternal", () => {
    it("lets a valid internal token through without touching req.user", () => {
      const { req, res, next } = runWith(requireInternal, { "x-internal-auth": signWithClock({ svc: "venue-service" }, INTERNAL) });
      expect(next).toHaveBeenCalledOnce();
      expect(res.status).not.toHaveBeenCalled();
      expect(req.user).toBeUndefined();
    });

    it.each([undefined, "", ["a", "b"], 5])("answers 401 no_internal_token for the header %j", (header) => {
      const { res, next } = runWith(requireInternal, { "x-internal-auth": header });
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledExactlyOnceWith(401);
      expect(res.json).toHaveBeenCalledExactlyOnceWith({ error: "Missing internal token", code: "no_internal_token" });
    });

    it("answers 401 invalid_internal_token for a forged, expired or user token", () => {
      for (const token of [
        signWithClock({ svc: "x" }, "wrong"),
        signWithClock({ svc: "x" }, INTERNAL, { expiresIn: -1 }),
        signToken({ sub: "U", role: "coordinator" }),
        "garbage",
      ]) {
        const { res, next } = runWith(requireInternal, { "x-internal-auth": token });
        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledExactlyOnceWith(401);
        expect(res.json).toHaveBeenCalledExactlyOnceWith({ error: "Invalid internal token", code: "invalid_internal_token" });
      }
    });
  });

  describe("requireAuthOrInternal", () => {
    it("trusts a valid internal token and attaches the client but no user", () => {
      const { req, next } = runWith(requireAuthOrInternal, { "x-internal-auth": signWithClock({ svc: "venue-service" }, INTERNAL) });
      expect(next).toHaveBeenCalledOnce();
      expect(req.user).toBeUndefined();
      expect(req.supabase).toEqual({ marker: "admin" });
    });

    it("refuses an invalid internal token outright instead of falling back to the user token", () => {
      const userToken = `Bearer ${signToken({ sub: "U", role: "coordinator" })}`;
      const { res, next } = runWith(requireAuthOrInternal, { "x-internal-auth": "garbage", authorization: userToken });
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledExactlyOnceWith(401);
      expect(res.json).toHaveBeenCalledExactlyOnceWith({ error: "Invalid internal token", code: "invalid_internal_token" });
    });

    it.each([undefined, "", ["a"], 5])("falls back to the user token when the internal header is %j", (header) => {
      const authorization = `Bearer ${signToken({ sub: "U-9", role: "coordinator" })}`;
      const { req, next } = runWith(requireAuthOrInternal, { "x-internal-auth": header, authorization });
      expect(next).toHaveBeenCalledOnce();
      expect(req.user).toEqual({ id: "U-9", role: "coordinator" });
    });

    it("answers 401 when there is neither", () => {
      const { res, next } = runWith(requireAuthOrInternal, {});
      expect(next).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ error: "Missing bearer token", code: "no_token" });
    });
  });
});
