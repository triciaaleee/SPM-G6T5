import { describe, expect, it, vi } from "vitest";
import { invalidVenueMessage, parseVenueInput, toVenueColumns, toVenueRecord } from "../lib/venueRecord.js";
import { isRealDate, parseVenueSearch } from "../lib/venueSearch.js";
import {
  MAX_PERIOD_DAYS,
  MAX_REASON_LENGTH,
  describePeriod,
  findBlockedVenueIds,
  findClashingPeriod,
  parsePeriodInput,
  toBuffers,
  toPeriod,
} from "../lib/unavailability.js";
import {
  checkSuitability,
  effectivePlan,
  hasPlan,
  holdsMainProgramme,
  parseBookingPlan,
  purposeLabel,
} from "../lib/bookingPlan.js";
import { datesBetween, findFreeSlots } from "../lib/availability.js";
import { formatWindow, occupiedWindow, overlaps } from "../lib/bookingConflicts.js";
import { BOOKING_STATUSES, blocksVenue, canTransition } from "../lib/bookingStatus.js";
import { assignedVenueIds, isAssignedToVenue } from "../lib/venueStaff.js";
import { createFakeDb } from "./helpers/fakeDb.js";

describe("boundary and edge cases", () => {
  /**
   * Boundary/edge tests for input validation. Limits are asserted on both
   * sides (last valid value passes, first invalid fails) with the exact
   * message, so moving a `<` to `<=`, dropping a branch or editing a limit
   * is caught.
   */

  const venue = (o: Record<string, unknown> = {}) => ({
    name: "Hall",
    location: "North",
    description: "d",
    capacity: 10,
    openingTime: "08:00",
    closingTime: "22:00",
    layouts: ["Theatre"],
    facilities: ["Projector"],
    accessibility: ["Ramp"],
    ...o,
  });
  const fieldsOf = (body: unknown) => {
    const r = parseVenueInput(body);
    if (r.valid) throw new Error("expected invalid");
    return r;
  };

  describe("parseVenueInput", () => {
    it("accepts a minimal valid venue and applies defaults (buffers 0, description null)", () => {
      const r = parseVenueInput(venue({ description: "  " }));
      expect(r).toEqual({
        valid: true,
        venue: {
          name: "Hall", location: "North", description: null, capacity: 10,
          accessibility: ["Ramp"], layouts: ["Theatre"], facilities: ["Projector"],
          setupMinutes: 0, turnaroundMinutes: 0, openingTime: "08:00", closingTime: "22:00",
        },
      });
    });

    it("treats a missing/non-object body as everything missing", () => {
      for (const body of [undefined, null, {}]) {
        expect(fieldsOf(body).missing).toEqual(["name", "location", "maximum capacity", "operating hours", "supported layouts", "facilities", "accessibility features"]);
      }
    });

    it("name: 120 characters is the last valid length, 121 is rejected; whitespace-only is missing", () => {
      expect(parseVenueInput(venue({ name: "a".repeat(120) })).valid).toBe(true);
      expect(fieldsOf(venue({ name: "a".repeat(121) })).fields.name).toBe("Keep the name to 120 characters.");
      expect(fieldsOf(venue({ name: "   " })).missing).toContain("name");
      expect(fieldsOf(venue({ name: 5 })).fields.name).toBe("Enter the venue's name.");
    });

    it("description: 1000 characters passes, 1001 fails", () => {
      expect(parseVenueInput(venue({ description: "a".repeat(1000) })).valid).toBe(true);
      expect(fieldsOf(venue({ description: "a".repeat(1001) })).fields.description).toBe("Keep the description to 1000 characters.");
    });

    it("capacity: 1 passes; 0, -1, 1.5, 'abc' fail; blank is missing; numeric strings are accepted", () => {
      expect(parseVenueInput(venue({ capacity: 1 })).valid).toBe(true);
      expect(parseVenueInput(venue({ capacity: " 25 " }))).toMatchObject({ valid: true, venue: { capacity: 25 } });
      for (const capacity of [0, -1, 1.5, "abc", "1.5", true]) {
        expect(fieldsOf(venue({ capacity })).fields.capacity).toBe("Capacity must be a whole number of at least 1.");
      }
      const blank = fieldsOf(venue({ capacity: "" }));
      expect(blank.fields.capacity).toBe("Enter the maximum capacity.");
      expect(blank.missing).toContain("maximum capacity");
    });

    it.each(["setupMinutes", "turnaroundMinutes"] as const)("%s: 0 and 1440 pass; -1 and 1441 and non-numbers fail; blank means 0", (key) => {
      expect(parseVenueInput(venue({ [key]: 0 }))).toMatchObject({ valid: true });
      expect(parseVenueInput(venue({ [key]: 1440 }))).toMatchObject({ valid: true });
      expect(parseVenueInput(venue({ [key]: "" }))).toMatchObject({ valid: true });
      const label = key === "setupMinutes" ? "the setup time" : "the turnaround time";
      for (const v of [-1, 1441, 2.5, "soon"]) {
        expect(fieldsOf(venue({ [key]: v })).fields[key]).toBe(`Enter ${label} in whole minutes, from 0 to 1440.`);
      }
    });

    it("operating hours: closing must be strictly after opening; 24:00 closes the day; bad formats are named", () => {
      expect(parseVenueInput(venue({ openingTime: "00:00", closingTime: "24:00" })).valid).toBe(true);
      expect(parseVenueInput(venue({ openingTime: "08:00", closingTime: "08:01" })).valid).toBe(true);
      expect(fieldsOf(venue({ openingTime: "08:00", closingTime: "08:00" })).fields.closingTime).toBe("The closing time must be after the opening time.");
      expect(fieldsOf(venue({ openingTime: "09:00", closingTime: "08:00" })).fields.closingTime).toBe("The closing time must be after the opening time.");
      expect(fieldsOf(venue({ openingTime: "25:00" })).fields.openingTime).toBe("Enter the opening time as HH:MM.");
      expect(fieldsOf(venue({ openingTime: "08:60" })).fields.openingTime).toBe("Enter the opening time as HH:MM.");
      expect(fieldsOf(venue({ closingTime: "9:00" })).fields.closingTime).toBe("Enter the closing time as HH:MM.");
      expect(fieldsOf(venue({ closingTime: "24:01" })).fields.closingTime).toBe("Enter the closing time as HH:MM.");
      const none = fieldsOf(venue({ openingTime: "", closingTime: "" }));
      expect(none.fields).toMatchObject({ openingTime: "Enter an opening time.", closingTime: "Enter a closing time." });
      expect(none.missing).toContain("operating hours");
      // a bad opening time must not also produce a misleading ordering error
      expect(fieldsOf(venue({ openingTime: "xx", closingTime: "08:00" })).fields.closingTime).toBeUndefined();
    });

    it("lists: trims, drops blanks, de-duplicates case-insensitively keeping the first spelling", () => {
      const r = parseVenueInput(venue({ layouts: [" Theatre ", "theatre", "", "Banquet", "THEATRE"] }));
      expect(r).toMatchObject({ valid: true, venue: { layouts: ["Theatre", "Banquet"] } });
    });

    it.each(["layouts", "facilities", "accessibility"] as const)("%s: empty, blank-only or missing is rejected as missing; non-array and non-string items are rejected", (key) => {
      const msg = {
        layouts: ["supported layouts", "Choose at least one supported layout."],
        facilities: ["facilities", "Choose at least one facility."],
        accessibility: ["accessibility features", 'Choose at least one accessibility feature, or "No accessibility features".'],
      }[key];
      for (const v of [[], [" "], undefined, null]) {
        const r = fieldsOf(venue({ [key]: v }));
        expect(r.fields[key]).toBe(msg[1]);
        expect(r.missing).toContain(msg[0]);
      }
      for (const v of ["Theatre", { a: 1 }, [1], ["ok", 2]]) {
        const r = fieldsOf(venue({ [key]: v }));
        expect(r.fields[key]).toBe("Send a list of options.");
        expect(r.missing).not.toContain(msg[0]);
      }
    });

    it("noAccessibilityFeatures: explicit true stores an empty list; combining it with features is rejected; only literal true counts", () => {
      expect(parseVenueInput(venue({ accessibility: [], noAccessibilityFeatures: true }))).toMatchObject({ valid: true, venue: { accessibility: [] } });
      expect(parseVenueInput(venue({ accessibility: undefined, noAccessibilityFeatures: true }))).toMatchObject({ valid: true });
      expect(fieldsOf(venue({ accessibility: ["Ramp"], noAccessibilityFeatures: true })).fields.accessibility).toBe(
        'Choose accessibility features or "No accessibility features", not both.',
      );
      expect(fieldsOf(venue({ accessibility: [], noAccessibilityFeatures: "true" })).fields.accessibility).toBeDefined();
      expect(fieldsOf(venue({ accessibility: [], noAccessibilityFeatures: 1 })).fields.accessibility).toBeDefined();
    });
  });

  describe("invalidVenueMessage / toVenueColumns / toVenueRecord", () => {
    it("names the missing attributes, or falls back to a generic message", () => {
      expect(invalidVenueMessage(["name", "facilities"])).toBe("Missing required details: name, facilities");
      expect(invalidVenueMessage([])).toBe("Some venue details are invalid");
    });

    it("maps a validated venue to snake_case columns", () => {
      const parsed = parseVenueInput(venue({ setupMinutes: 5, turnaroundMinutes: 7 }));
      if (!parsed.valid) throw new Error("invalid");
      expect(toVenueColumns(parsed.venue)).toEqual({
        name: "Hall", location: "North", description: "d", capacity: 10,
        accessibility: ["Ramp"], layouts: ["Theatre"], facilities: ["Projector"],
        setup_minutes: 5, turnaround_minutes: 7, opening_time: "08:00", closing_time: "22:00",
      });
    });

    it("toVenueRecord trims Postgres HH:MM:SS and fills nulls with defaults", () => {
      expect(toVenueRecord({ id: 1, name: "A", location: "B", description: null, capacity: 3, accessibility: null, layouts: null, facilities: null, setup_minutes: null, turnaround_minutes: null, opening_time: null, closing_time: null, status: "Available" })).toEqual({
        id: 1, name: "A", location: "B", description: "", capacity: 3, accessibility: [], layouts: [], facilities: [],
        setupMinutes: 0, turnaroundMinutes: 0, openingTime: "08:00", closingTime: "22:00", status: "Available",
      });
      expect(toVenueRecord({ id: 1, name: "A", location: "B", description: "d", capacity: 3, accessibility: ["x"], layouts: ["y"], facilities: ["z"], setup_minutes: 15, turnaround_minutes: 20, opening_time: "09:30:00", closing_time: "17:45:00", status: "Available" })).toMatchObject({
        description: "d", accessibility: ["x"], setupMinutes: 15, turnaroundMinutes: 20, openingTime: "09:30", closingTime: "17:45",
      });
    });
  });

  describe("isRealDate", () => {
    it.each([["2026-02-28", true], ["2028-02-29", true], ["2026-02-29", false], ["2026-04-31", false], ["2026-13-01", false], ["2026-00-10", false], ["2026-01-00", false], ["2026-1-01", false], ["", false], ["2026-01-01T00:00", false]])("%j → %s", (value, expected) => {
      expect(isRealDate(value)).toBe(expected);
    });
  });

  describe("parseVenueSearch", () => {
    const bad = (q: Record<string, unknown>) => {
      const r = parseVenueSearch(q);
      if (r.valid) throw new Error("expected invalid");
      return r.fields;
    };

    it("no params is valid with empty criteria", () => expect(parseVenueSearch({})).toEqual({ valid: true, criteria: {} }));

    it("ignores blank strings, takes the first of repeated keys and ignores non-strings", () => {
      expect(parseVenueSearch({ q: "   " })).toEqual({ valid: true, criteria: {} });
      expect(parseVenueSearch({ q: [" hall ", "other"] })).toEqual({ valid: true, criteria: { q: "hall" } });
      expect(parseVenueSearch({ q: 5, attendance: {} })).toEqual({ valid: true, criteria: {} });
    });

    it("date must be a real calendar date", () => {
      expect(bad({ date: "2026-02-30" }).date).toBe("Date must be a valid date (YYYY-MM-DD)");
      expect(parseVenueSearch({ date: "2026-02-28" })).toEqual({ valid: true, criteria: { date: "2026-02-28" } });
    });

    it("times: boundaries 00:00 and 23:59 pass; 24:00, 23:60, 9:00 fail", () => {
      expect(parseVenueSearch({ date: "2026-09-14", startTime: "00:00", endTime: "23:59" })).toEqual({
        valid: true, criteria: { date: "2026-09-14", startTime: "00:00", endTime: "23:59" },
      });
      expect(bad({ date: "2026-09-14", startTime: "24:00", endTime: "23:59" }).startTime).toBe("Start time must be HH:MM");
      expect(bad({ date: "2026-09-14", startTime: "10:00", endTime: "23:60" }).endTime).toBe("End time must be HH:MM");
      expect(bad({ date: "2026-09-14", startTime: "9:00", endTime: "10:00" }).startTime).toBe("Start time must be HH:MM");
    });

    it("a time window needs a date and both ends; end must be strictly after start", () => {
      expect(bad({ startTime: "10:00", endTime: "11:00" }).date).toBe("Pick a date to search by time");
      expect(bad({ endTime: "11:00" }).date).toBe("Pick a date to search by time");
      expect(bad({ date: "2026-09-14", startTime: "10:00" }).endTime).toBe("Give both a start and an end time");
      expect(bad({ date: "2026-09-14", endTime: "10:00" }).endTime).toBe("Give both a start and an end time");
      expect(bad({ date: "2026-09-14", startTime: "10:00", endTime: "10:00" }).endTime).toBe("End time must be after start time");
      expect(bad({ date: "2026-09-14", startTime: "10:01", endTime: "10:00" }).endTime).toBe("End time must be after start time");
      expect(parseVenueSearch({ date: "2026-09-14", startTime: "10:00", endTime: "10:01" }).valid).toBe(true);
    });

    it.each(["attendance", "capacityMin", "capacityMax"])("%s: 1 passes; 0, -1, 1.5, 01, abc fail", (key) => {
      expect(parseVenueSearch({ [key]: "1" })).toEqual({ valid: true, criteria: { [key]: 1 } });
      for (const v of ["0", "-1", "1.5", "01", "abc"]) expect(bad({ [key]: v })[key]).toBe("Must be a whole number greater than 0");
    });

    it("capacityMin may equal capacityMax but not exceed it", () => {
      expect(parseVenueSearch({ capacityMin: "50", capacityMax: "50" }).valid).toBe(true);
      expect(bad({ capacityMin: "51", capacityMax: "50" }).capacityMax).toBe("Maximum capacity must be at least the minimum");
    });

    it("list params accept repeated keys and comma lists, trim and de-duplicate", () => {
      expect(parseVenueSearch({ facilities: ["A, B", "B", " ", 7], layouts: "Theatre,,Theatre", accessibility: "", locations: [] })).toEqual({
        valid: true, criteria: { facilities: ["A", "B"], layouts: ["Theatre"] },
      });
    });
  });

  describe("parsePeriodInput", () => {
    const invalid = (body: unknown) => {
      const r = parsePeriodInput(body);
      if (r.valid) throw new Error("expected invalid");
      return r.fields;
    };
    const ok = { startDate: "2026-09-14", reason: "Maintenance" };

    it("defaults: endDate = startDate, all day, times nulled even if sent", () => {
      expect(parsePeriodInput({ ...ok, startTime: "09:00", endTime: "10:00" })).toEqual({
        valid: true,
        period: { startDate: "2026-09-14", endDate: "2026-09-14", allDay: true, startTime: null, endTime: null, reason: "Maintenance" },
      });
    });

    it("only a literal false turns all-day off", () => {
      expect(parsePeriodInput({ ...ok, allDay: 0, startTime: "x" })).toMatchObject({ valid: true, period: { allDay: true } });
      expect(parsePeriodInput({ ...ok, allDay: false, startTime: "09:00", endTime: "13:00" })).toMatchObject({
        valid: true, period: { allDay: false, startTime: "09:00", endTime: "13:00" },
      });
    });

    it("treats a non-object body like an empty one", () => {
      for (const body of [null, undefined, "x", 5]) {
        expect(invalid(body)).toEqual({ startDate: "Enter a valid start date.", endDate: "Enter a valid end date.", reason: "Give a reason." });
      }
    });

    it("span: 366 days (inclusive of 365 gap) is the maximum; 367 is rejected; reversed range rejected", () => {
      expect(MAX_PERIOD_DAYS).toBe(366);
      expect(parsePeriodInput({ ...ok, startDate: "2026-01-01", endDate: "2026-12-31" }).valid).toBe(true); // 364-day gap
      expect(parsePeriodInput({ ...ok, startDate: "2026-01-01", endDate: "2027-01-01" }).valid).toBe(true); // 365-day gap
      expect(invalid({ ...ok, startDate: "2026-01-01", endDate: "2027-01-02" }).endDate).toBe("A block-out can cover at most 366 days.");
      expect(invalid({ ...ok, startDate: "2026-01-02", endDate: "2026-01-01" }).endDate).toBe("The end date must not be before the start date.");
      expect(parsePeriodInput({ ...ok, startDate: "2026-01-01", endDate: "2026-01-01" }).valid).toBe(true);
    });

    it("an impossible start date does not also produce a range error", () => {
      expect(invalid({ ...ok, startDate: "2026-02-30", endDate: "2026-03-01" })).toEqual({ startDate: "Enter a valid start date." });
    });

    it("timed block: end must be strictly after start; bad formats are named", () => {
      const t = (startTime: string, endTime: string) => invalid({ ...ok, allDay: false, startTime, endTime });
      expect(t("09:00", "09:00").endTime).toBe("The end time must be after the start time.");
      expect(t("10:00", "09:00").endTime).toBe("The end time must be after the start time.");
      expect(t("", "").startTime).toBe("Enter a start time.");
      expect(t("24:00", "10:00").startTime).toBe("Enter a start time.");
      expect(t("09:00", "9:5").endTime).toBe("Enter an end time.");
      expect(parsePeriodInput({ ...ok, allDay: false, startTime: "23:58", endTime: "23:59" }).valid).toBe(true);
    });

    it("reason: required, trimmed, 200 characters max", () => {
      expect(MAX_REASON_LENGTH).toBe(200);
      expect(invalid({ ...ok, reason: "   " }).reason).toBe("Give a reason.");
      expect(invalid({ ...ok, reason: 5 }).reason).toBe("Give a reason.");
      expect(parsePeriodInput({ ...ok, reason: "a".repeat(200) }).valid).toBe(true);
      expect(invalid({ ...ok, reason: "a".repeat(201) }).reason).toBe("Keep the reason under 200 characters.");
      expect(parsePeriodInput({ ...ok, reason: "  fix  " })).toMatchObject({ period: { reason: "fix" } });
    });
  });

  describe("toPeriod / toBuffers / describePeriod", () => {
    const row = { id: 1, venue_id: 2, start_date: "2026-09-14", end_date: "2026-09-16", all_day: false, start_time: "09:00:00", end_time: "13:30:00", reason: "r" };
    it("trims times to HH:MM for timed periods and nulls them for all-day", () => {
      expect(toPeriod(row)).toEqual({ id: 1, venueId: 2, startDate: "2026-09-14", endDate: "2026-09-16", allDay: false, startTime: "09:00", endTime: "13:30", reason: "r" });
      expect(toPeriod({ ...row, all_day: true })).toMatchObject({ allDay: true, startTime: null, endTime: null });
      expect(toPeriod({ ...row, start_time: null, end_time: null })).toMatchObject({ startTime: null, endTime: null });
    });
    it("toBuffers defaults missing minutes to 0", () => {
      expect(toBuffers({})).toEqual({ setupMinutes: 0, turnaroundMinutes: 0 });
      expect(toBuffers({ setup_minutes: null, turnaround_minutes: 9 })).toEqual({ setupMinutes: 0, turnaroundMinutes: 9 });
      expect(toBuffers({ setup_minutes: 4, turnaround_minutes: 0 })).toEqual({ setupMinutes: 4, turnaroundMinutes: 0 });
    });
    it("describePeriod phrases single/multi day and all-day/timed", () => {
      const p = toPeriod(row);
      expect(describePeriod(p)).toBe("from 2026-09-14 to 2026-09-16 (09:00–13:30)");
      expect(describePeriod({ ...p, endDate: "2026-09-14", allDay: true })).toBe("on 2026-09-14 (all day)");
    });
  });

  /** Chain stub: every builder returns itself; awaiting yields `result`. */
  function chain(result: { data: unknown; error: unknown }) {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "lte", "gte"]) c[m] = vi.fn(() => c);
    c.then = (res: (v: unknown) => unknown) => res(result);
    return { from: vi.fn(() => c), c };
  }
  const periodRow = { id: 9, venue_id: 1, start_date: "2026-09-14", end_date: "2026-09-14", all_day: true, start_time: null, end_time: null, reason: "r" };
  const DAY0 = Date.UTC(2026, 8, 14);

  describe("findBlockedVenueIds / findClashingPeriod", () => {
    it("no windows → empty set without querying", async () => {
      const sb = chain({ data: [], error: null });
      expect(await findBlockedVenueIds(sb as never, new Map())).toEqual(new Set());
      expect(sb.from).not.toHaveBeenCalled();
    });
    it("returns null on a query error, an empty set on null data", async () => {
      const w = new Map([[1, { startMs: DAY0, endMs: DAY0 + 3600_000 }]]);
      expect(await findBlockedVenueIds(chain({ data: null, error: { message: "x" } }) as never, w)).toBeNull();
      expect(await findBlockedVenueIds(chain({ data: null, error: null }) as never, w)).toEqual(new Set());
    });
    it("blocks only venues whose own window the period overlaps, ignoring other venues' rows", async () => {
      const w = new Map([[1, { startMs: DAY0 + 10 * 3600_000, endMs: DAY0 + 11 * 3600_000 }]]);
      const sb = chain({ data: [periodRow, { ...periodRow, id: 10, venue_id: 2 }], error: null });
      expect(await findBlockedVenueIds(sb as never, w)).toEqual(new Set([1]));
    });
    it("queries the day of the last occupied millisecond (end is exclusive)", async () => {
      const w = new Map([[1, { startMs: DAY0, endMs: DAY0 + 24 * 3600_000 }]]);
      const sb = chain({ data: [], error: null });
      await findBlockedVenueIds(sb as never, w);
      expect(sb.c.lte).toHaveBeenCalledWith("start_date", "2026-09-14");
      expect(sb.c.gte).toHaveBeenCalledWith("end_date", "2026-09-14");
    });
    it("the lookup spans from the earliest start to the latest end across all venues", async () => {
      const DAY = 24 * 3600_000;
      const w = new Map([
        [1, { startMs: DAY0 + 10 * 3600_000, endMs: DAY0 + 11 * 3600_000 }],
        [2, { startMs: DAY0 + 3 * DAY + 10 * 3600_000, endMs: DAY0 + 3 * DAY + 11 * 3600_000 }],
        [3, { startMs: DAY0 + 1 * DAY, endMs: DAY0 + 1 * DAY + 3600_000 }],
      ]);
      const sb = chain({ data: [], error: null });
      await findBlockedVenueIds(sb as never, w);
      expect(sb.c.lte).toHaveBeenCalledWith("start_date", "2026-09-17");
      expect(sb.c.gte).toHaveBeenCalledWith("end_date", "2026-09-14");
    });
    it("findClashingPeriod looks up the venue's periods from the window's first day to its last occupied day", async () => {
      const sb = chain({ data: [], error: null });
      await findClashingPeriod(sb as never, 7, { startMs: DAY0 + 23 * 3600_000, endMs: DAY0 + 48 * 3600_000 });
      expect(sb.c.eq).toHaveBeenCalledWith("venue_id", 7);
      expect(sb.c.lte).toHaveBeenCalledWith("start_date", "2026-09-15");
      expect(sb.c.gte).toHaveBeenCalledWith("end_date", "2026-09-14");
    });
    it("findClashingPeriod: a window ending exactly at midnight does not reach into the next day", async () => {
      const sb = chain({ data: [], error: null });
      await findClashingPeriod(sb as never, 1, { startMs: DAY0, endMs: DAY0 + 24 * 3600_000 });
      expect(sb.c.lte).toHaveBeenCalledWith("start_date", "2026-09-14");
    });
    it("findClashingPeriod: error, none, clash", async () => {
      const win = { startMs: DAY0 + 3600_000, endMs: DAY0 + 7200_000 };
      expect(await findClashingPeriod(chain({ data: null, error: { message: "x" } }) as never, 1, win)).toEqual({ status: "error" });
      expect(await findClashingPeriod(chain({ data: null, error: null }) as never, 1, win)).toEqual({ status: "ok", period: null });
      const hit = await findClashingPeriod(chain({ data: [periodRow], error: null }) as never, 1, win);
      expect(hit).toMatchObject({ status: "ok", period: { id: 9, venueId: 1 } });
      // the window ends the day before the period starts → no clash
      const before = { startMs: DAY0 - 7200_000, endMs: DAY0 };
      expect(await findClashingPeriod(chain({ data: [periodRow], error: null }) as never, 1, before)).toEqual({ status: "ok", period: null });
    });
  });

  describe("booking plan edges", () => {
    const defaults = { attendance: 100, requirements: { layouts: ["Theatre"], facilities: ["Projector"], accessibility: ["Ramp"] } };

    it("hasPlan is true for any plan key, false for none", () => {
      expect(hasPlan({})).toBe(false);
      expect(hasPlan({ name: "x" })).toBe(false);
      for (const k of ["purpose", "purposeDetail", "headcount", "layouts", "facilities", "accessibility"]) expect(hasPlan({ [k]: null })).toBe(true);
    });

    it("empty plan falls back to the main programme, full attendance and the event's own needs", () => {
      expect(parseBookingPlan({}, defaults)).toEqual({
        valid: true,
        plan: { purpose: "Main programme", purposeDetail: null, headcount: 100, requirements: defaults.requirements },
      });
    });

    it("purpose matches case-insensitively and trimmed; unknown is named with the allowed list", () => {
      expect(parseBookingPlan({ purpose: "  breakout " }, defaults)).toMatchObject({ valid: true, plan: { purpose: "Breakout" } });
      expect(parseBookingPlan({ purpose: 5 }, defaults)).toEqual({ valid: false, fields: { purpose: "Choose one of: Main programme, Breakout, Registration, Catering, Other." } });
      expect(parseBookingPlan({ purpose: "Party" }, defaults)).toMatchObject({ valid: false });
    });

    it("'Other' needs a detail of 1–80 characters", () => {
      expect(parseBookingPlan({ purpose: "Other" }, defaults)).toEqual({ valid: false, fields: { purposeDetail: "Say what this venue is for." } });
      expect(parseBookingPlan({ purpose: "Other", purposeDetail: 5 }, defaults)).toMatchObject({ valid: false });
      expect(parseBookingPlan({ purpose: "Other", purposeDetail: "a".repeat(80) }, defaults)).toMatchObject({ valid: true, plan: { purposeDetail: "a".repeat(80) } });
      expect(parseBookingPlan({ purpose: "Other", purposeDetail: "a".repeat(81) }, defaults)).toEqual({ valid: false, fields: { purposeDetail: "Keep it to 80 characters." } });
      expect(parseBookingPlan({ purpose: "Breakout", purposeDetail: "ignored" }, defaults)).toMatchObject({ plan: { purposeDetail: null } });
    });

    it("headcount: 1 and the full attendance pass; 0, attendance+1, fractions and text fail", () => {
      expect(parseBookingPlan({ headcount: 1 }, defaults)).toMatchObject({ valid: true, plan: { headcount: 1 } });
      expect(parseBookingPlan({ headcount: "100" }, defaults)).toMatchObject({ valid: true, plan: { headcount: 100 } });
      expect(parseBookingPlan({ headcount: 0 }, defaults)).toEqual({ valid: false, fields: { headcount: "The headcount must be a whole number of at least 1." } });
      expect(parseBookingPlan({ headcount: 1.5 }, defaults)).toMatchObject({ valid: false });
      expect(parseBookingPlan({ headcount: "x" }, defaults)).toMatchObject({ valid: false });
      expect(parseBookingPlan({ headcount: 101 }, defaults)).toEqual({ valid: false, fields: { headcount: "The headcount can't be more than the event's expected attendance (100)." } });
    });

    it("with no known attendance a headcount is required and has no upper bound", () => {
      const unknown = { ...defaults, attendance: null };
      expect(parseBookingPlan({}, unknown)).toEqual({ valid: false, fields: { headcount: "Enter the expected headcount for this venue." } });
      expect(parseBookingPlan({ headcount: 5000 }, unknown)).toMatchObject({ valid: true, plan: { headcount: 5000 } });
    });

    it("feature lists replace the event's, dedupe case-insensitively, and reject non-lists", () => {
      expect(parseBookingPlan({ layouts: [" Banquet ", "banquet", " "], facilities: [] }, defaults)).toMatchObject({
        valid: true, plan: { requirements: { layouts: ["Banquet"], facilities: [], accessibility: ["Ramp"] } },
      });
      expect(parseBookingPlan({ layouts: ["a", 1] }, defaults)).toEqual({ valid: false, fields: { layouts: "Send a list of options." } });
      expect(parseBookingPlan({ facilities: { a: 1 } }, defaults)).toMatchObject({ valid: false });
      // an omitted list falls back to the event's; an explicit null is a malformed list
      expect(parseBookingPlan({ accessibility: null }, defaults)).toEqual({ valid: false, fields: { accessibility: "Send a list of options." } });
      expect(parseBookingPlan({ accessibility: undefined }, defaults)).toMatchObject({ valid: true, plan: { requirements: { accessibility: ["Ramp"] } } });
      expect(parseBookingPlan({ layouts: "Banquet" }, defaults)).toMatchObject({ plan: { requirements: { layouts: ["Banquet"] } } });
    });

    it("effectivePlan falls back per field; unknown purpose becomes the main programme; detail only for Other", () => {
      expect(effectivePlan({}, defaults)).toEqual({ purpose: "Main programme", purposeDetail: null, headcount: 100, requirements: defaults.requirements });
      expect(effectivePlan({ purpose: "Mystery", purpose_detail: "x" }, defaults)).toMatchObject({ purpose: "Main programme", purposeDetail: null });
      expect(effectivePlan({ purpose: "Other", purpose_detail: "Photos" }, defaults)).toMatchObject({ purposeDetail: "Photos" });
      expect(effectivePlan({ purpose: "Other" }, defaults)).toMatchObject({ purposeDetail: null });
      expect(effectivePlan({ purpose: "Breakout", purpose_detail: "x", headcount: 0, required_layouts: [], required_facilities: ["F"], required_accessibility: [] }, defaults)).toEqual({
        purpose: "Breakout", purposeDetail: null, headcount: 0, requirements: { layouts: [], facilities: ["F"], accessibility: [] },
      });
    });

    it("holdsMainProgramme counts only live main-programme bookings", () => {
      const main = (status: string, purpose: string | null = null) => ({ status, purpose });
      expect(holdsMainProgramme([], defaults)).toBe(false);
      for (const s of ["Requested", "On Hold", "Approved"]) expect(holdsMainProgramme([main(s)], defaults)).toBe(true);
      for (const s of ["Rejected", "Expired", "Withdrawn", "Cancelled", "Replacement Required"]) expect(holdsMainProgramme([main(s)], defaults)).toBe(false);
      expect(holdsMainProgramme([main("Approved", "Breakout")], defaults)).toBe(false);
      expect(holdsMainProgramme([main("Approved", "Breakout"), main("Requested", "Main programme")], defaults)).toBe(true);
    });

    it("purposeLabel shows the typed detail only for Other", () => {
      expect(purposeLabel({ purpose: "Other", purposeDetail: "Photos" })).toBe("Photos");
      expect(purposeLabel({ purpose: "Other", purposeDetail: null })).toBe("Other");
      expect(purposeLabel({ purpose: "Breakout", purposeDetail: "Photos" })).toBe("Breakout");
    });

    it("checkSuitability: capacity equal to headcount is fine, one short is not; unknown headcount never fails capacity", () => {
      const v = { capacity: 50, layouts: ["Theatre"], facilities: ["Projector"], accessibility: ["Ramp"] };
      const reqs = { layouts: [], facilities: [], accessibility: [] };
      expect(checkSuitability(v, { headcount: 50, requirements: reqs })).toEqual({ suitable: true, reasons: [] });
      expect(checkSuitability(v, { headcount: 51, requirements: reqs })).toEqual({ suitable: false, reasons: [{ kind: "capacity", capacity: 50, headcount: 51 }] });
      expect(checkSuitability(v, { headcount: null, requirements: reqs }).suitable).toBe(true);
    });

    it("checkSuitability: features compare case-insensitively and report exactly what is missing, per group", () => {
      const v = { capacity: 50, layouts: ["THEATRE"], facilities: null as never, accessibility: ["ramp"] };
      expect(checkSuitability(v, { headcount: 1, requirements: { layouts: ["theatre", "Banquet"], facilities: ["Projector"], accessibility: ["RAMP"] } })).toEqual({
        suitable: false,
        reasons: [{ kind: "layouts", missing: ["Banquet"] }, { kind: "facilities", missing: ["Projector"] }],
      });
    });
  });

  /**
   * Boundary and edge cases for the pure time/status helpers. Every expected
   * value is an exact literal (not recomputed with the code under test) so a
   * flipped comparison, off-by-one or swapped operand changes a number or a
   * boolean here and fails.
   */
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  const D = Date.UTC(2026, 8, 14); // 2026-09-14 00:00 UTC

  describe("occupiedWindow", () => {
    it("pads start by setup and end by turnaround (10:00–12:00, 30/45 → 09:30–12:45)", () => {
      expect(occupiedWindow({ proposedDate: "2026-09-14", startTime: "10:00", endTime: "12:00" }, { setup_minutes: 30, turnaround_minutes: 45 })).toEqual({
        startMs: D + (9 * 60 + 30) * MIN,
        endMs: D + (12 * 60 + 45) * MIN,
      });
    });

    it("applies no padding when none is given, and treats null padding as 0", () => {
      const expected = { startMs: D + 600 * MIN, endMs: D + 720 * MIN };
      expect(occupiedWindow({ proposedDate: "2026-09-14", startTime: "10:00", endTime: "12:00" })).toEqual(expected);
      expect(occupiedWindow({ proposedDate: "2026-09-14", startTime: "10:00", endTime: "12:00" }, { setup_minutes: null, turnaround_minutes: null })).toEqual(expected);
    });

    it("ignores negative padding rather than shrinking the window", () => {
      expect(occupiedWindow({ proposedDate: "2026-09-14", startTime: "10:00", endTime: "12:00" }, { setup_minutes: -30, turnaround_minutes: -45 })).toEqual({
        startMs: D + 600 * MIN,
        endMs: D + 720 * MIN,
      });
    });

    it("lets padding cross midnight in both directions", () => {
      const w = occupiedWindow({ proposedDate: "2026-09-14", startTime: "00:10", endTime: "23:50" }, { setup_minutes: 20, turnaround_minutes: 20 })!;
      expect(w.startMs).toBe(D - 10 * MIN);
      expect(w.endMs).toBe(D + DAY + 10 * MIN);
    });

    it.each([
      ["no times", null, null],
      ["no start", null, "12:00"],
      ["no end", "10:00", null],
      ["end equal to start", "10:00", "10:00"],
      ["end before start", "12:00", "10:00"],
      ["unparseable start", "ten", "12:00"],
      ["hour 24", "24:00", "23:59"],
      ["minute 60", "10:60", "12:00"],
    ])("falls back to the whole day (%s)", (_n, startTime, endTime) => {
      expect(occupiedWindow({ proposedDate: "2026-09-14", startTime, endTime }, { setup_minutes: 5, turnaround_minutes: 7 })).toEqual({
        startMs: D - 5 * MIN,
        endMs: D + DAY + 7 * MIN,
      });
    });

    it.each([
      ["trailing seconds (HH:MM:SS is not HH:MM)", "10:00:00", "12:00"],
      ["leading garbage on the start", "x10:00", "12:00"],
      ["trailing garbage on the end", "10:00", "12:00x"],
      ["end hour 24 (24:00 is not a time of day here)", "23:00", "24:00"],
    ])("falls back to the whole day for %s", (_n, startTime, endTime) => {
      expect(occupiedWindow({ proposedDate: "2026-09-14", startTime, endTime })).toEqual({ startMs: D, endMs: D + DAY });
    });

    it.each([["x2026-09-14"], ["12026-09-14"], ["2026-09-14x"], [" 2026-09-14"]])("returns null for a date with extra characters (%j)", (proposedDate) => {
      expect(occupiedWindow({ proposedDate, startTime: "10:00", endTime: "11:00" })).toBeNull();
    });

    it("accepts the last valid minute 23:59 and first minute 00:00", () => {
      expect(occupiedWindow({ proposedDate: "2026-09-14", startTime: "00:00", endTime: "23:59" })).toEqual({
        startMs: D,
        endMs: D + (23 * 60 + 59) * MIN,
      });
    });

    it.each([[undefined], [null], [""], ["2026-9-14"], ["14/09/2026"], ["2026-09-14T00:00"]])("returns null for date %j", (proposedDate) => {
      expect(occupiedWindow({ proposedDate: proposedDate as string | null | undefined, startTime: "10:00", endTime: "11:00" })).toBeNull();
    });
  });

  describe("overlaps (half-open)", () => {
    const a = { startMs: 100, endMs: 200 };
    it("touching windows do not overlap, in either order", () => {
      expect(overlaps(a, { startMs: 200, endMs: 300 })).toBe(false);
      expect(overlaps({ startMs: 0, endMs: 100 }, a)).toBe(false);
    });
    it("one millisecond of overlap does, in either order", () => {
      expect(overlaps(a, { startMs: 199, endMs: 300 })).toBe(true);
      expect(overlaps({ startMs: 0, endMs: 101 }, a)).toBe(true);
    });
    it("containment and identity overlap", () => {
      expect(overlaps(a, { startMs: 120, endMs: 150 })).toBe(true);
      expect(overlaps({ startMs: 120, endMs: 150 }, a)).toBe(true);
      expect(overlaps(a, a)).toBe(true);
    });
    it("disjoint windows do not overlap", () => {
      expect(overlaps(a, { startMs: 500, endMs: 600 })).toBe(false);
      expect(overlaps({ startMs: 500, endMs: 600 }, a)).toBe(false);
    });
  });

  describe("formatWindow", () => {
    it("shows one date when the window stays within a day", () => {
      expect(formatWindow({ startMs: D + (9 * 60 + 30) * MIN, endMs: D + (12 * 60 + 45) * MIN })).toBe("2026-09-14 09:30–12:45");
    });
    it("spells out both dates across midnight", () => {
      expect(formatWindow({ startMs: D - 10 * MIN, endMs: D + DAY + 10 * MIN })).toBe("2026-09-13 23:50 – 2026-09-15 00:10");
    });
    it("zero-pads single-digit months, days, hours and minutes", () => {
      expect(formatWindow({ startMs: Date.UTC(2026, 0, 5, 1, 2), endMs: Date.UTC(2026, 0, 5, 3, 4) })).toBe("2026-01-05 01:02–03:04");
    });
  });

  describe("blocksVenue", () => {
    const now = new Date("2026-09-14T12:00:00Z");
    it("Approved always blocks", () => expect(blocksVenue({ status: "Approved" }, now)).toBe(true));
    it.each(["Requested", "Rejected", "Expired", "Withdrawn", "Cancelled", "Replacement Required"] as const)("%s never blocks", (status) => {
      expect(blocksVenue({ status, hold_expires_at: "2099-01-01T00:00:00Z" }, now)).toBe(false);
    });
    it("an On Hold with no expiry blocks (safe reading)", () => {
      expect(blocksVenue({ status: "On Hold" }, now)).toBe(true);
      expect(blocksVenue({ status: "On Hold", hold_expires_at: null }, now)).toBe(true);
    });
    it("an On Hold blocks until the exact expiry instant, and not at or after it", () => {
      expect(blocksVenue({ status: "On Hold", hold_expires_at: "2026-09-14T12:00:00.001Z" }, now)).toBe(true);
      expect(blocksVenue({ status: "On Hold", hold_expires_at: "2026-09-14T12:00:00.000Z" }, now)).toBe(false);
      expect(blocksVenue({ status: "On Hold", hold_expires_at: "2026-09-14T11:59:59.999Z" }, now)).toBe(false);
    });
    it("uses the real clock when no `now` is passed", () => {
      expect(blocksVenue({ status: "On Hold", hold_expires_at: new Date(Date.now() + 60_000).toISOString() })).toBe(true);
      expect(blocksVenue({ status: "On Hold", hold_expires_at: new Date(Date.now() - 60_000).toISOString() })).toBe(false);
    });
  });

  describe("canTransition: the whole §3a table", () => {
    const allowed: Record<string, string[]> = {
      Requested: ["On Hold", "Approved", "Rejected", "Withdrawn"],
      "On Hold": ["Approved", "Rejected", "Expired", "Withdrawn"],
      Approved: ["Replacement Required", "Cancelled", "Withdrawn"],
      Rejected: [],
      Expired: [],
      "Replacement Required": ["Withdrawn"],
      Withdrawn: [],
      Cancelled: [],
    };
    for (const from of BOOKING_STATUSES) {
      for (const to of BOOKING_STATUSES) {
        it(`${from} → ${to} is ${allowed[from].includes(to) ? "allowed" : "refused"}`, () => {
          expect(canTransition(from, to)).toBe(allowed[from].includes(to));
        });
      }
    }
    it("refuses an unknown source status", () => {
      expect(canTransition("Bogus" as never, "Approved")).toBe(false);
    });
  });

  describe("datesBetween", () => {
    it("is inclusive of both ends", () => expect(datesBetween("2026-09-14", "2026-09-16")).toEqual(["2026-09-14", "2026-09-15", "2026-09-16"]));
    it("returns one date when from equals to", () => expect(datesBetween("2026-09-14", "2026-09-14")).toEqual(["2026-09-14"]));
    it("returns nothing when to is before from", () => expect(datesBetween("2026-09-14", "2026-09-13")).toEqual([]));
    it("crosses month, year and leap-day boundaries", () => {
      expect(datesBetween("2026-12-31", "2027-01-01")).toEqual(["2026-12-31", "2027-01-01"]);
      expect(datesBetween("2028-02-28", "2028-03-01")).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
      expect(datesBetween("2027-02-28", "2027-03-01")).toEqual(["2027-02-28", "2027-03-01"]);
    });
  });

  describe("findFreeSlots range clamping", () => {
    const hours = { openingTime: "08:00", closingTime: "18:00" };
    const buffers = { setup_minutes: 0, turnaround_minutes: 0 } as never;
    const target = (fromDate: string, toDate: string) => ({ fromDate, toDate, startTime: null, endTime: null });
    const dates = (slots: { date: string }[]) => [...new Set(slots.map((s) => s.date))];

    it("returns nothing when the target ends before the loaded range starts", () => {
      expect(findFreeSlots({ from: "2026-09-10", to: "2026-09-20" }, target("2026-09-01", "2026-09-09"), [], [], hours, buffers)).toEqual([]);
    });
    it("returns nothing when the target starts after the loaded range ends", () => {
      expect(findFreeSlots({ from: "2026-09-10", to: "2026-09-20" }, target("2026-09-21", "2026-09-25"), [], [], hours, buffers)).toEqual([]);
    });
    it("clamps to the intersection of target and range on both sides", () => {
      const slots = findFreeSlots({ from: "2026-09-10", to: "2026-09-12" }, target("2026-09-11", "2026-09-30"), [], [], hours, buffers);
      expect(dates(slots)).toEqual(["2026-09-11", "2026-09-12"]);
      const slots2 = findFreeSlots({ from: "2026-09-10", to: "2026-09-30" }, target("2026-09-01", "2026-09-11"), [], [], hours, buffers);
      expect(dates(slots2)).toEqual(["2026-09-10", "2026-09-11"]);
    });
    it("a single-day intersection yields that day only", () => {
      expect(dates(findFreeSlots({ from: "2026-09-10", to: "2026-09-10" }, target("2026-09-10", "2026-09-10"), [], [], hours, buffers))).toEqual(["2026-09-10"]);
    });
  });
});

describe("venue staff assignment", () => {
  /** Chainable supabase stub: every builder method returns itself, the chain resolves to `result`. */
  function stub(result: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) chain[m] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => result);
    chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
    return { from: vi.fn(() => chain), chain };
  }

  describe("assignedVenueIds", () => {
    it("returns the ids of the venues the staff member looks after", async () => {
      const sb = stub({ data: [{ id: 1 }, { id: 4 }], error: null });
      const r = await assignedVenueIds(sb as never, "VEN-0001");
      expect(r).toEqual({ status: "ok", venueIds: [1, 4] });
      expect(sb.from).toHaveBeenCalledWith("venues");
      expect(sb.chain.eq).toHaveBeenCalledWith("staff_id", "VEN-0001");
    });

    it("returns an empty list when nothing is assigned (null data)", async () => {
      const r = await assignedVenueIds(stub({ data: null, error: null }) as never, "VEN-0002");
      expect(r).toEqual({ status: "ok", venueIds: [] });
    });

    it("reports an error rather than an empty list when the query fails", async () => {
      const r = await assignedVenueIds(stub({ data: null, error: { message: "boom" } }) as never, "VEN-0001");
      expect(r).toEqual({ status: "error" });
    });
  });

  describe("isAssignedToVenue", () => {
    it("is assigned when a matching venue row exists", async () => {
      const sb = stub({ data: { id: 3 }, error: null });
      expect(await isAssignedToVenue(sb as never, "VEN-0001", 3)).toEqual({ status: "ok", assigned: true });
      expect(sb.chain.eq).toHaveBeenCalledWith("id", 3);
      expect(sb.chain.eq).toHaveBeenCalledWith("staff_id", "VEN-0001");
    });

    it("is not assigned when no row matches", async () => {
      expect(await isAssignedToVenue(stub({ data: null, error: null }) as never, "VEN-0001", 3)).toEqual({
        status: "ok",
        assigned: false,
      });
    });

    it("reports an error when the query fails", async () => {
      expect(await isAssignedToVenue(stub({ data: null, error: { message: "x" } }) as never, "VEN-0001", 3)).toEqual({
        status: "error",
      });
    });
  });

  describe("isAssignedToVenue asks only for the venue id", () => {
    it("selects just id, and reads assignment from the row existing", async () => {
      const db = createFakeDb({ venues: [{ id: 1, staff_id: "S1", name: "Hall" }] });
      expect(await isAssignedToVenue(db as never, "S1", 1)).toEqual({ status: "ok", assigned: true });
      expect(await isAssignedToVenue(db as never, "S2", 1)).toEqual({ status: "ok", assigned: false });
      expect(db.calls.map((c) => c.columns)).toEqual(["id", "id"]);
    });
  });
});
