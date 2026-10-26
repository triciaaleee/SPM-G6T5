import { describe, expect, it } from "vitest";
import { extractFeatures, extractLayoutAndFacilities, extractRequirements, isNoPreference, scheduleQuery } from "../lib/venueRecommendation.js";
import { searchVenues, type VenueRow } from "../lib/venueSearch.js";

describe("isNoPreference", () => {
  it.each(["", "   ", "n/a", "NA", "None", "no", "nope", "---", "Not applicable", "no preference", "No requirements", "not needed.", "Not required"])("%j means no preference", (v) => {
    expect(isNoPreference(v)).toBe(true);
  });
  it.each([undefined, null, 5, {}, []])("a non-string (%j) means no preference", (v) => expect(isNoPreference(v)).toBe(true));
  it.each(["projector", "no projector please", "none of the above rooms"])("%j is a real answer", (v) => expect(isNoPreference(v)).toBe(false));
});

describe("extractFeatures", () => {
  it("finds nothing for no-preference text", () => {
    expect(extractFeatures("n/a")).toEqual({ accessibility: [], layouts: [], facilities: [] });
  });
  it("respects negation within a clause only", () => {
    expect(extractFeatures("no projector").facilities).toEqual([]);
    expect(extractFeatures("without a projector").facilities).toEqual([]);
    expect(extractFeatures("no stage, projector").facilities).toEqual(["Projector"]);
    expect(extractFeatures("We have no budget. Projector needed").facilities).toEqual(["Projector"]);
  });
  it("counts a phrase once and reports in written order, de-duplicated", () => {
    const f = extractFeatures("Wi-Fi and a projector, plus projector again").facilities;
    expect(f).toEqual(["Wi-Fi", "Projector"]);
  });
});

describe("extractRequirements", () => {
  it("rounds attendance up to a whole seat and rejects zero, negative and non-numeric", () => {
    const att = (v: unknown) => extractRequirements({ expectedAttendance: v }).attendance;
    expect(att(150.5)).toBe(151);
    expect(att("150")).toBe(150);
    expect(att(1)).toBe(1);
    expect(att(0.2)).toBe(1);
    expect(att(0)).toBeNull();
    expect(att(-5)).toBeNull();
    expect(att("lots")).toBeNull();
    expect(att(undefined)).toBeNull();
    expect(att(Infinity)).toBeNull();
  });
  it("trims schedule strings and nulls blanks and non-strings", () => {
    expect(extractRequirements({ proposedDate: " 2026-09-14 ", startTime: "  ", endTime: 5 })).toMatchObject({ date: "2026-09-14", startTime: null, endTime: null });
  });
  it("ignores non-string requirement fields and merges features across fields", () => {
    const r = extractRequirements({ venue: 42, equipment: "projector", technicalSupport: null, accessibility: "wheelchair ramp" });
    expect(r.facilities).toEqual(["Projector"]);
    expect(extractLayoutAndFacilities({ venue: 42, equipment: "projector" })).toEqual({ layouts: [], facilities: ["Projector"] });
  });
});

describe("scheduleQuery", () => {
  const base = { attendance: null, date: null, startTime: null, endTime: null, accessibility: [], layouts: [], facilities: [] };
  it("is empty when nothing is known", () => expect(scheduleQuery(base)).toEqual({}));
  it("includes attendance as a string, including the smallest value 1", () => expect(scheduleQuery({ ...base, attendance: 1 })).toEqual({ attendance: "1" }));
  it("includes times only together with a date and both ends", () => {
    expect(scheduleQuery({ ...base, date: "2026-09-14" })).toEqual({ date: "2026-09-14" });
    expect(scheduleQuery({ ...base, date: "2026-09-14", startTime: "10:00" })).toEqual({ date: "2026-09-14" });
    expect(scheduleQuery({ ...base, startTime: "10:00", endTime: "11:00" })).toEqual({});
    expect(scheduleQuery({ ...base, date: "2026-09-14", startTime: "10:00", endTime: "11:00" })).toEqual({ date: "2026-09-14", startTime: "10:00", endTime: "11:00" });
  });
});

describe("searchVenues with empty feature lists", () => {
  const v = (id: number): VenueRow => ({ id, name: `V${id}`, location: "L", description: null, capacity: 10, accessibility: [], layouts: [], facilities: [], setup_minutes: 0, turnaround_minutes: 0 } as never);
  it("an empty list is no constraint, undefined too", () => {
    expect(searchVenues([v(1), v(2)], { facilities: [], layouts: undefined }, new Set()).venues.map((x) => x.id)).toEqual([1, 2]);
  });
});
