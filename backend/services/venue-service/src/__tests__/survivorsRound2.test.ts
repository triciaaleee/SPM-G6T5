import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findFreeSlots, freeSlotsForDay, subtractIntervals } from "../lib/availability.js";
import { fetchVenueBookingInfo } from "../lib/eventsClient.js";
import { MAX_EVENT_IDS, parseEventIds } from "../lib/eventIds.js";
import { isAssignedToVenue } from "../lib/venueStaff.js";
import { normalizePair } from "../lib/venueChanges.js";
import { searchVenues, type VenueRow } from "../lib/venueSearch.js";
import { extractFeatures } from "../lib/venueRecommendation.js";
import { createFakeDb } from "./helpers/fakeDb.js";

/**
 * Second mutation-run follow-ups: boundaries that two blocks or two windows
 * share, calls that must not be made at all, and the exact shape of an
 * `eventIds` query.
 */

const iv = (start: string, end: string) => ({ start, end });

describe("subtractIntervals: blocks that meet", () => {
  const window = iv("08:00", "12:00");

  it("two blocks that touch leave no empty gap between them", () => {
    expect(subtractIntervals(window, [iv("09:00", "10:00"), iv("10:00", "11:00")])).toEqual([iv("08:00", "09:00"), iv("11:00", "12:00")]);
  });

  it("a block that starts where the previous one ended does not widen the free time before it", () => {
    expect(subtractIntervals(window, [iv("08:00", "09:00"), iv("09:00", "10:00")])).toEqual([iv("10:00", "12:00")]);
  });

  it("a gap never runs past the end of the window, whatever blocks follow it", () => {
    expect(subtractIntervals(window, [iv("13:00", "14:00"), iv("15:00", "16:00")])).toEqual([window]);
    expect(subtractIntervals(window, [iv("11:00", "11:30"), iv("14:00", "15:00")])).toEqual([iv("08:00", "11:00"), iv("11:30", "12:00")]);
  });

  it("a block that starts exactly where the window ends changes nothing", () => {
    expect(subtractIntervals(window, [iv("12:00", "13:00")])).toEqual([window]);
  });
});

describe("freeSlotsForDay: the target window", () => {
  const hours = { openingTime: "08:00", closingTime: "20:00" };
  const day = { date: "2026-11-10", bookings: [], periods: [] };
  const none = { setupMinutes: 0, turnaroundMinutes: 0 };

  it.each([
    ["wholly before opening", "05:00", "07:00"],
    ["ending exactly at opening", "06:00", "08:00"],
    ["wholly after closing", "21:00", "22:00"],
    ["starting exactly at closing", "20:00", "22:00"],
    ["empty", "10:00", "10:00"],
    ["back to front", "12:00", "10:00"],
  ])("a target window %s has no slots", (_name, startTime, endTime) => {
    expect(freeSlotsForDay(day, hours, none, { startTime, endTime })).toEqual([]);
  });

  it("a one-minute target window is one slot", () => {
    expect(freeSlotsForDay(day, hours, none, { startTime: "10:00", endTime: "10:01" })).toEqual([
      { date: "2026-11-10", start: "10:00", end: "10:01", eventStart: "10:00", eventEnd: "10:01" },
    ]);
  });

  it("a gap that the target window only touches is skipped, not shown empty", () => {
    const booked = { ...day, bookings: [{ date: "2026-11-10", startTime: "08:00", endTime: "12:00" }] };
    // Free from 12:00; the target ends at 12:00 exactly.
    expect(freeSlotsForDay(booked, hours, none, { startTime: "09:00", endTime: "12:00" })).toEqual([]);
    expect(freeSlotsForDay(booked, hours, none, { startTime: "09:00", endTime: "12:01" })).toEqual([
      { date: "2026-11-10", start: "12:00", end: "12:01", eventStart: "12:00", eventEnd: "12:01" },
    ]);
  });
});

describe("findFreeSlots: the loaded range against the target days", () => {
  const hours = { openingTime: "08:00", closingTime: "09:00" };
  const none = { setupMinutes: 0, turnaroundMinutes: 0 };
  const target = (fromDate: string, toDate: string) => ({ fromDate, toDate, startTime: null, endTime: null });
  const dates = (range: { from: string; to: string }, t: ReturnType<typeof target>) =>
    findFreeSlots(range, t, [], [], hours, none).map((slot) => slot.date);
  const RANGE = { from: "2026-11-10", to: "2026-11-12" };

  it("keeps the later start and the earlier end", () => {
    expect(dates(RANGE, target("2026-11-01", "2026-11-30"))).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"]);
    expect(dates(RANGE, target("2026-11-11", "2026-11-30"))).toEqual(["2026-11-11", "2026-11-12"]);
    expect(dates(RANGE, target("2026-11-01", "2026-11-11"))).toEqual(["2026-11-10", "2026-11-11"]);
    expect(dates(RANGE, target("2026-11-11", "2026-11-11"))).toEqual(["2026-11-11"]);
  });

  it("returns nothing when the target days and the range do not meet", () => {
    expect(dates(RANGE, target("2026-11-01", "2026-11-09"))).toEqual([]);
    expect(dates(RANGE, target("2026-11-13", "2026-11-20"))).toEqual([]);
  });

  it("touching at a single day is that day", () => {
    expect(dates(RANGE, target("2026-11-01", "2026-11-10"))).toEqual(["2026-11-10"]);
    expect(dates(RANGE, target("2026-11-12", "2026-11-20"))).toEqual(["2026-11-12"]);
  });
});

describe("normalizePair", () => {
  it.each([
    [1, 2, [1, 2]],
    [2, 1, [1, 2]],
    [7, 7, [7, 7]],
    [10, 9, [9, 10]],
  ])("(%d, %d) is %j", (a, b, expected) => {
    expect(normalizePair(a, b)).toEqual(expected);
  });
});

describe("fetchVenueBookingInfo with nothing to ask for", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("answers ok with no events and never calls events-service", async () => {
    expect(await fetchVenueBookingInfo([], "Bearer t")).toEqual({ status: "ok", events: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("parseEventIds", () => {
  it.each([
    ["1", [1]],
    ["1,2,3", [1, 2, 3]],
    [" 4 , 5 ", [4, 5]],
    ["3,3,3", [3]],
    ["2,1,2,1", [2, 1]],
    ["10,9", [10, 9]],
  ])("%j is read as %j", (raw, expected) => {
    expect(parseEventIds(raw)).toEqual(expected);
  });

  it.each(["", " ", ",", "1,", ",1", "1,,2", "0", "01", "-1", "1.5", "1e2", "abc", "1,x", "1 2", "0x10", "+3"])("%j is rejected", (raw) => {
    expect(parseEventIds(raw)).toBeNull();
  });

  it.each([undefined, null, 5, ["1", "2"], ["1"], {}, true])("a non-string %j is rejected", (raw) => {
    expect(parseEventIds(raw)).toBeNull();
  });

  it("allows exactly the maximum number of ids and no more", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    expect(MAX_EVENT_IDS).toBe(100);
    expect(parseEventIds(ids(MAX_EVENT_IDS).join(","))).toEqual(ids(MAX_EVENT_IDS));
    expect(parseEventIds(ids(MAX_EVENT_IDS + 1).join(","))).toBeNull();
  });

  it("counts the ids as sent, so repeats still count towards the maximum", () => {
    expect(parseEventIds(Array(MAX_EVENT_IDS + 1).fill("1").join(","))).toBeNull();
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

describe("search text", () => {
  const venue = (o: Partial<VenueRow>): VenueRow => ({
    id: 1, name: "Alpha", location: "North", description: null, capacity: 10, accessibility: [], layouts: [], facilities: [], ...o,
  });

  it("a venue with no description is found by its name and location but never by filler text", () => {
    const v = venue({});
    const ids = (q: string) => searchVenues([v], { q }, new Set()).venues.map((x) => x.id);
    expect(ids("alpha")).toEqual([1]);
    expect(ids("north")).toEqual([1]);
    expect(ids("stryker")).toEqual([]);
    expect(ids("was here")).toEqual([]);
  });
});

describe("free-text reader", () => {
  it("reads a phrase split over two lines with indentation, as if it were on one", () => {
    expect(extractFeatures("open\n      floor").layouts).toEqual(["Open floor"]);
    expect(extractFeatures("open  \n  floor").layouts).toEqual(["Open floor"]);
  });

  it("reports features in the order they were written, even when a longer phrase is found first", () => {
    // Long phrases are read first and blanked out; the order must still follow the text.
    expect(extractFeatures("ramp. accessible parking. lift").accessibility).toEqual([
      "Ramp access",
      "Accessible parking",
      "Lift access",
    ]);
  });

  it("a whole-field 'no preference' answer finds nothing, even when a venue lists that very word as a feature", () => {
    const venue: VenueRow = {
      id: 1, name: "Hall", location: "North", description: null, capacity: 10,
      accessibility: ["N/A"], layouts: ["None"], facilities: ["Nil"],
    };
    for (const text of ["n/a", "none", "nil", "No preference", "not applicable"]) {
      expect(extractFeatures(text, [venue])).toEqual({ accessibility: [], layouts: [], facilities: [] });
    }
    // The same words inside a real sentence are still read.
    expect(extractFeatures("we need nil", [venue]).facilities).toEqual(["Nil"]);
  });
});

describe("free-text reader: odd spellings", () => {
  const venue = (facilities: string[]): VenueRow => ({
    id: 1, name: "Hall", location: "North", description: null, capacity: 10, accessibility: [], layouts: [], facilities,
  });

  it("a venue's own feature written with a hyphen and a space is still recognised in the same spelling", () => {
    expect(extractFeatures("we have wi- fi here", [venue(["Wi- Fi"])]).facilities).toEqual(["Wi- Fi"]);
    expect(extractFeatures("we have wi-fi here", [venue(["Wi- Fi"])]).facilities).toEqual(["Wi- Fi"]);
  });

  it("text that is not any feature finds nothing, whatever a feature without synonyms is called", () => {
    expect(extractFeatures("Stryker was here")).toEqual({ accessibility: [], layouts: [], facilities: [] });
  });

  it("the '-style' spellings of a layout are read through the layout's own name", () => {
    expect(extractFeatures("classroom-style, banquet style, cabaret-style and boardroom style").layouts).toEqual([
      "Classroom",
      "Banquet",
      "Cabaret",
      "Boardroom",
    ]);
  });
});
