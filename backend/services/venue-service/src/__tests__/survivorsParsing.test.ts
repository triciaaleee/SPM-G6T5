import { describe, expect, it } from "vitest";
import { parseVenueInput } from "../lib/venueRecord.js";
import { isRealDate, parseVenueSearch } from "../lib/venueSearch.js";
import { parsePeriodInput } from "../lib/unavailability.js";
import { parseBookingPlan, type EventDefaults } from "../lib/bookingPlan.js";

/**
 * Pins down what a mutation run showed no test noticed: the regex anchors
 * (`^` / `$`), the trim of padded input, and what counts as "blank". Each
 * case is a value one character away from valid, with the exact message
 * expected, so dropping an anchor or a `.trim()` changes an answer.
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
const venueFields = (body: unknown) => {
  const r = parseVenueInput(body);
  return r.valid ? {} : r.fields;
};

describe("venue record: whole numbers (capacity, setup, turnaround)", () => {
  const CAPACITY_MSG = "Capacity must be a whole number of at least 1.";

  it.each(["12abc", "x12", "1 2", "1.5", "1e2", "--5", "+5", "0x10", "12\n3", "abc"])("capacity %j is rejected", (capacity) => {
    expect(venueFields(venue({ capacity }))).toEqual({ capacity: CAPACITY_MSG });
  });

  it.each([
    ["12", 12],
    ["  12  ", 12],
    ["007", 7],
    [12, 12],
  ])("capacity %j is read as %d", (capacity, expected) => {
    const r = parseVenueInput(venue({ capacity }));
    expect(r.valid && r.venue.capacity).toBe(expected);
  });

  it.each(["-5", "0", -1, 0, "-0"])("capacity %j is below the minimum of 1", (capacity) => {
    expect(venueFields(venue({ capacity }))).toEqual({ capacity: CAPACITY_MSG });
  });

  it.each(["", "   ", null, undefined])("a blank capacity %j is missing, not malformed", (capacity) => {
    const r = parseVenueInput(venue({ capacity }));
    expect(r).toEqual({ valid: false, fields: { capacity: "Enter the maximum capacity." }, missing: ["maximum capacity"] });
  });

  it.each([false, {}, [], true])("a non-blank non-number capacity %j is malformed, not missing", (capacity) => {
    expect(venueFields(venue({ capacity }))).toEqual({ capacity: CAPACITY_MSG });
  });

  it.each(["x5", "5x", "5.5", "-1", "1 0"])("setup minutes %j is rejected with the exact message", (setupMinutes) => {
    expect(venueFields(venue({ setupMinutes }))).toEqual({ setupMinutes: "Enter the setup time in whole minutes, from 0 to 1440." });
  });

  it.each([
    ["   ", 0],
    ["", 0],
    [null, 0],
    [" 45 ", 45],
    ["240", 240],
  ])("turnaround %j is read as %d", (turnaroundMinutes, expected) => {
    const r = parseVenueInput(venue({ turnaroundMinutes }));
    expect(r.valid && r.venue.turnaroundMinutes).toBe(expected);
  });

  it("a malformed turnaround names the turnaround time", () => {
    expect(venueFields(venue({ turnaroundMinutes: "5x" }))).toEqual({
      turnaroundMinutes: "Enter the turnaround time in whole minutes, from 0 to 1440.",
    });
  });
});

describe("venue record: operating hours", () => {
  it.each(["08:00x", "x08:00", "8:00", "08:0", "08:60", "25:00", "24:01", "24:00x", "x24:00", "08-00", ""])(
    "opening time %j is rejected",
    (openingTime) => {
      const expected = openingTime === "" ? "Enter an opening time." : "Enter the opening time as HH:MM.";
      expect(venueFields(venue({ openingTime }))).toMatchObject({ openingTime: expected });
    },
  );

  it.each(["22:00x", "x22:00", "9:00", "24:01", "24:00x", "x24:00", "23:60", ""])("closing time %j is rejected", (closingTime) => {
    const expected = closingTime === "" ? "Enter a closing time." : "Enter the closing time as HH:MM.";
    expect(venueFields(venue({ closingTime }))).toEqual({ closingTime: expected });
  });

  it("accepts midnight (24:00) as a closing time and 00:00 / 23:59 at the edges", () => {
    expect(parseVenueInput(venue({ openingTime: "00:00", closingTime: "24:00" })).valid).toBe(true);
    expect(parseVenueInput(venue({ openingTime: "23:58", closingTime: "23:59" })).valid).toBe(true);
  });

  it("one hour missing still lists 'operating hours' as missing", () => {
    expect(parseVenueInput(venue({ openingTime: "" }))).toMatchObject({ valid: false, missing: ["operating hours"] });
    expect(parseVenueInput(venue({ closingTime: "" }))).toMatchObject({ valid: false, missing: ["operating hours"] });
    expect(parseVenueInput(venue({ openingTime: "", closingTime: "" }))).toMatchObject({ valid: false, missing: ["operating hours"] });
  });

  it("an empty location says where the venue is", () => {
    expect(venueFields(venue({ location: "" }))).toEqual({ location: "Enter where the venue is." });
  });
});

describe("period input: dates and times", () => {
  const period = (o: Record<string, unknown> = {}) => ({
    startDate: "2026-11-10",
    endDate: "2026-11-12",
    allDay: true,
    reason: "Maintenance",
    ...o,
  });
  const timed = (o: Record<string, unknown> = {}) => period({ allDay: false, startTime: "09:00", endTime: "13:00", ...o });
  const fieldsOf = (body: unknown) => {
    const r = parsePeriodInput(body);
    return r.valid ? {} : r.fields;
  };

  it.each(["09:00x", "x09:00", "9:00", "09:0", "24:00", "09:60", "", "0900"])("start time %j is rejected", (startTime) => {
    expect(fieldsOf(timed({ startTime }))).toEqual({ startTime: "Enter a start time." });
  });

  it.each(["13:00x", "x13:00", "1:00", "13:0", "24:00", "13:60", "", "1300"])("end time %j is rejected", (endTime) => {
    expect(fieldsOf(timed({ endTime }))).toEqual({ endTime: "Enter an end time." });
  });

  it.each(["2026-11-10x", "x2026-11-10", "2026-11-1", "2026/11/10", "20261110", "2026-13-10", "2026-02-30"])(
    "start date %j is rejected",
    (startDate) => {
      expect(fieldsOf(period({ startDate, endDate: undefined }))).toEqual({
        startDate: "Enter a valid start date.",
        endDate: "Enter a valid end date.",
      });
    },
  );

  it("a bad time never produces the 'must be after' message for the other, valid, time", () => {
    // 99:99 is invalid; 09:00 is valid and sorts before it.
    expect(fieldsOf(timed({ startTime: "99:99", endTime: "09:00" }))).toEqual({ startTime: "Enter a start time." });
    expect(fieldsOf(timed({ startTime: "09:00", endTime: "99:99" }))).toEqual({ endTime: "Enter an end time." });
    // Both bad: each keeps its own message, neither is overwritten.
    expect(fieldsOf(timed({ startTime: "99:99", endTime: "88:88" }))).toEqual({
      startTime: "Enter a start time.",
      endTime: "Enter an end time.",
    });
  });

  it("the 'must be after' message needs both times valid and end <= start", () => {
    expect(fieldsOf(timed({ startTime: "13:00", endTime: "13:00" }))).toEqual({ endTime: "The end time must be after the start time." });
    expect(fieldsOf(timed({ startTime: "13:00", endTime: "09:00" }))).toEqual({ endTime: "The end time must be after the start time." });
    expect(fieldsOf(timed({ startTime: "09:00", endTime: "09:01" }))).toEqual({});
  });
});

describe("venue search: date, time and blank handling", () => {
  const search = (q: Record<string, unknown>) => parseVenueSearch(q);

  it.each(["2026-11-10x", "x2026-11-10", "2026-1-10", "2026-11-1", "2026-11-10 ", "2026-02-30", "26-11-10"])(
    "date %j is not a real date",
    (date) => {
      const trimmed = date.trim();
      // A trailing space is trimmed by the parser, so that one is valid.
      if (trimmed === "2026-11-10") {
        expect(search({ date })).toEqual({ valid: true, criteria: { date: "2026-11-10" } });
      } else {
        expect(search({ date })).toEqual({ valid: false, fields: { date: "Date must be a valid date (YYYY-MM-DD)" } });
      }
    },
  );

  it("isRealDate demands the exact YYYY-MM-DD shape", () => {
    expect(isRealDate("2026-11-10")).toBe(true);
    for (const bad of ["2026-11-10x", "x2026-11-10", "2026-11-10T00:00", "2026-1-1", "", " 2026-11-10"]) {
      expect(isRealDate(bad)).toBe(false);
    }
  });

  it.each(["10:00x", "x10:00", "1:00", "10:0", "24:00", "10:60"])("start time %j is rejected", (startTime) => {
    expect(search({ date: "2026-11-10", startTime, endTime: "23:00" })).toEqual({
      valid: false,
      fields: { startTime: "Start time must be HH:MM" },
    });
  });

  it.each(["11:00x", "x11:00", "1:00", "11:0", "24:00", "11:60"])("end time %j is rejected", (endTime) => {
    expect(search({ date: "2026-11-10", startTime: "10:00", endTime })).toEqual({
      valid: false,
      fields: { endTime: "End time must be HH:MM" },
    });
  });

  it("a whitespace-only value is the same as not sending it", () => {
    expect(search({ date: "   ", startTime: "  ", endTime: "\t", q: "  ", attendance: " ", locations: " , " })).toStrictEqual({
      valid: true,
      criteria: {},
    });
  });

  it("an absent q or list leaves no key on the criteria at all", () => {
    const result = search({ date: "2026-11-10" });
    expect(result.valid && Object.keys(result.criteria)).toEqual(["date"]);
    const withQ = search({ q: " hall ", layouts: "Theatre, Banquet" });
    expect(withQ).toStrictEqual({ valid: true, criteria: { q: "hall", layouts: ["Theatre", "Banquet"] } });
  });
});

describe("booking plan: blanks and whole numbers", () => {
  const defaults: EventDefaults = { attendance: 100, requirements: { layouts: [], facilities: [], accessibility: [] } };
  const noAttendance: EventDefaults = { attendance: null, requirements: { layouts: [], facilities: [], accessibility: [] } };
  const fieldsOf = (raw: Record<string, unknown>, d: EventDefaults = defaults) => {
    const r = parseBookingPlan(raw, d);
    return r.valid ? {} : r.fields;
  };
  const MSG = "The headcount must be a whole number of at least 1.";

  it.each(["12abc", "x12", "1 2", "1.5", "0", "-3", 0, 0.5, false, {}])("headcount %j is rejected", (headcount) => {
    expect(fieldsOf({ headcount })).toEqual({ headcount: MSG });
  });

  it.each([
    ["  7 ", 7],
    ["7", 7],
    [7, 7],
    ["100", 100],
  ])("headcount %j is read as %d", (headcount, expected) => {
    const r = parseBookingPlan({ headcount }, defaults);
    expect(r.valid && r.plan.headcount).toBe(expected);
  });

  it.each([undefined, null, "", "   ", "\t"])("a blank headcount %j falls back to the event's attendance", (headcount) => {
    const r = parseBookingPlan({ headcount }, defaults);
    expect(r.valid && r.plan.headcount).toBe(100);
    expect(fieldsOf({ headcount }, noAttendance)).toEqual({ headcount: "Enter the expected headcount for this venue." });
  });

  it.each([undefined, null, "", "   "])("a blank purpose %j is the default main programme", (purpose) => {
    const r = parseBookingPlan({ purpose }, defaults);
    expect(r.valid && r.plan.purpose).toBe("Main programme");
  });

  it("a non-blank, non-string purpose is rejected rather than defaulted", () => {
    expect(fieldsOf({ purpose: 5 })).toMatchObject({ purpose: expect.stringContaining("Choose one of:") });
    expect(fieldsOf({ purpose: false })).toMatchObject({ purpose: expect.stringContaining("Choose one of:") });
  });
});
