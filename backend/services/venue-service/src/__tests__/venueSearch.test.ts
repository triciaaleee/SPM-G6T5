import { describe, expect, it } from "vitest";
import {
  activeCriteria,
  isRealDate,
  parseVenueSearch,
  searchVenues,
  type VenueRow,
  type VenueSearchCriteria,
} from "../lib/venueSearch.js";

/**
 * Venue search: which criteria count as "active", the exact labels offered
 * when a search finds nothing, free-text matching, and how the query string
 * is parsed (dates, times, blanks).
 */

const venues: VenueRow[] = [
  { id: 1, name: "Alpha", location: "North", description: "first", capacity: 50, accessibility: ["Ramp"], layouts: ["Theatre"], facilities: ["Projector"] },
  { id: 2, name: "Beta", location: "South", description: null, capacity: 80, accessibility: ["Lift"], layouts: ["Banquet"], facilities: ["Stage"] },
];

describe("activeCriteria", () => {
  it("is empty when nothing is set", () => {
    expect(activeCriteria({})).toEqual([]);
  });

  it.each<[string, VenueSearchCriteria, string[]]>([
    ["q", { q: "a" }, ["q"]],
    ["date", { date: "2026-11-10" }, ["availability"]],
    ["attendance", { attendance: 5 }, ["attendance"]],
    ["capacityMin", { capacityMin: 5 }, ["capacity"]],
    ["capacityMax", { capacityMax: 5 }, ["capacity"]],
    ["both capacities", { capacityMin: 5, capacityMax: 9 }, ["capacity"]],
    ["locations", { locations: ["North"] }, ["locations"]],
    ["accessibility", { accessibility: ["Ramp"] }, ["accessibility"]],
    ["layouts", { layouts: ["Theatre"] }, ["layouts"]],
    ["facilities", { facilities: ["Stage"] }, ["facilities"]],
    ["empty lists", { locations: [], accessibility: [], layouts: [], facilities: [] }, []],
  ])("%s", (_name, criteria, expected) => {
    expect(activeCriteria(criteria)).toEqual(expected);
  });

  it("keeps the fixed order whatever the order of the criteria", () => {
    expect(activeCriteria({ facilities: ["Stage"], q: "a", capacityMax: 9, date: "2026-11-10", attendance: 1 })).toEqual([
      "q",
      "availability",
      "attendance",
      "capacity",
      "facilities",
    ]);
  });
});

describe("searchVenues: what to relax when nothing matches", () => {
  const none = new Set<number>();

  // Each case has exactly one active criterion that nothing satisfies, so the
  // only suggestion is to drop that one, which brings both venues back.
  it.each<[string, VenueSearchCriteria, Set<number>, string, string]>([
    ["q", { q: "zzz" }, none, "q", "Search text"],
    ["availability", { date: "2026-11-10" }, new Set([1, 2]), "availability", "Date & time"],
    ["attendance", { attendance: 1000 }, none, "attendance", "Attendance"],
    ["capacity", { capacityMin: 1000 }, none, "capacity", "Capacity"],
    ["locations", { locations: ["Nowhere"] }, none, "locations", "Location"],
    ["accessibility", { accessibility: ["Teleporter"] }, none, "accessibility", "Accessibility"],
    ["layouts", { layouts: ["Cabaret"] }, none, "layouts", "Layout"],
    ["facilities", { facilities: ["Fireworks"] }, none, "facilities", "Facilities"],
  ])("%s", (_name, criteria, unavailable, key, label) => {
    expect(searchVenues(venues, criteria, unavailable)).toEqual({ venues: [], relax: [{ key, label, count: 2 }] });
  });

  it("when something matches there is nothing to relax, however many criteria are active", () => {
    expect(searchVenues(venues, { layouts: ["Theatre"] }, none)).toStrictEqual({ venues: [venues[0]], relax: [] });
    expect(searchVenues(venues, { layouts: ["Theatre"], facilities: ["Projector"], locations: ["North"] }, none)).toStrictEqual({
      venues: [venues[0]],
      relax: [],
    });
    expect(searchVenues(venues, {}, none)).toStrictEqual({ venues, relax: [] });
  });

  it("lists the suggestion that rescues the most venues first, even when it comes later in the fixed order", () => {
    const pool: VenueRow[] = [
      { ...venues[0], id: 1, name: "One", capacity: 100, layouts: ["Theatre"] },
      { ...venues[0], id: 2, name: "Two", capacity: 100, layouts: ["Banquet"] },
      { ...venues[0], id: 3, name: "Three", capacity: 10, layouts: ["Cabaret"] },
    ];
    // attendance 50 fits One and Two; Cabaret fits Three; nobody fits both.
    const result = searchVenues(pool, { attendance: 50, layouts: ["Cabaret"] }, none);
    expect(result.venues).toEqual([]);
    expect(result.relax).toEqual([
      { key: "layouts", label: "Layout", count: 2 },
      { key: "attendance", label: "Attendance", count: 1 },
    ]);
  });

  it("an empty result with no active criteria offers nothing", () => {
    expect(searchVenues([], {}, none)).toEqual({ venues: [], relax: [] });
  });

  it("suggestions come with the biggest rescue first", () => {
    const result = searchVenues(venues, { attendance: 60, layouts: ["Theatre"], locations: ["South"] }, none);
    expect(result.venues).toEqual([]);
    // Dropping attendance leaves Alpha-or-Beta by layout+location: none match both.
    // Dropping layouts leaves Beta (South, 80 >= 60); dropping locations leaves none (Alpha is 50).
    expect(result.relax).toEqual([{ key: "layouts", label: "Layout", count: 1 }]);
  });

  it("matches search text in the name, the location and the description, and a missing description matches nothing", () => {
    expect(searchVenues(venues, { q: "alph" }, none).venues.map((v) => v.id)).toEqual([1]);
    expect(searchVenues(venues, { q: "south" }, none).venues.map((v) => v.id)).toEqual([2]);
    expect(searchVenues(venues, { q: "FIRST" }, none).venues.map((v) => v.id)).toEqual([1]);
    expect(searchVenues(venues, { q: "null" }, none).venues).toEqual([]);
    expect(searchVenues(venues, { q: "undefined" }, none).venues).toEqual([]);
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
