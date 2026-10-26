import { describe, expect, it } from "vitest";
import { activeCriteria, searchVenues, type VenueRow, type VenueSearchCriteria } from "../lib/venueSearch.js";
import { occupiedWindow, periodBlocksSlot } from "../lib/unavailability.js";

/**
 * Mutation-run follow-ups: the exact labels offered when a search finds
 * nothing, which criteria count as "active", and the seconds-tolerant time
 * handling in the block-out helpers.
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

describe("block-out helpers accept times with seconds", () => {
  const buffers = { setupMinutes: 30, turnaroundMinutes: 45 };

  it("occupiedWindow reads HH:MM:SS the same as HH:MM", () => {
    expect(occupiedWindow("10:00:00", "12:00:00", buffers)).toEqual({ start: "09:30", end: "12:45" });
    expect(occupiedWindow("10:00", "12:00", buffers)).toEqual({ start: "09:30", end: "12:45" });
  });

  it("occupiedWindow clamps to the day and passes missing times through", () => {
    expect(occupiedWindow("00:10", "23:50", buffers)).toEqual({ start: "00:00", end: "24:00" });
    expect(occupiedWindow(null, "12:00", buffers)).toEqual({ start: null, end: null });
    expect(occupiedWindow("10:00", undefined, buffers)).toEqual({ start: null, end: null });
  });

  const timed = { startDate: "2026-11-10", endDate: "2026-11-10", allDay: false, startTime: "09:00", endTime: "13:00" };

  it("periodBlocksSlot: a slot that only touches the block does not clash, with or without seconds", () => {
    // Block 09:00-13:00; slot starts as it ends / ends as it starts.
    expect(periodBlocksSlot(timed, "2026-11-10", "13:00", "14:00")).toBe(false);
    expect(periodBlocksSlot(timed, "2026-11-10", "13:00:00", "14:00:00")).toBe(false);
    expect(periodBlocksSlot(timed, "2026-11-10", "08:00", "09:00")).toBe(false);
    expect(periodBlocksSlot(timed, "2026-11-10", "08:00:00", "09:00:00")).toBe(false);
    // One minute of overlap on either side clashes.
    expect(periodBlocksSlot(timed, "2026-11-10", "12:59:00", "14:00:00")).toBe(true);
    expect(periodBlocksSlot(timed, "2026-11-10", "08:00:00", "09:01:00")).toBe(true);
  });
});
