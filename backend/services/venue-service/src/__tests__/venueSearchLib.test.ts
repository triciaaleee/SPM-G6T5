import { describe, expect, it } from "vitest";
import {
  OPTION_CATALOGUE,
  type VenueRow,
  type VenueSearchCriteria,
  activeCriteria,
  isRealDate,
  parseVenueSearch,
  searchVenues,
} from "../lib/venueSearch.js";
import {
  extractFeatures,
  extractLayoutAndFacilities,
  extractRequirements,
  isNoPreference,
  scheduleQuery,
  withFeatures,
} from "../lib/venueRecommendation.js";
import { MAX_EVENT_IDS, parseEventIds } from "../lib/eventIds.js";

describe("venue search", () => {
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
});

describe("venue recommendation", () => {
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

  /**
   * Mutation-run follow-ups for the free-text reader. The phrasebook is spelled
   * out here in full, and each phrase is checked on its own, so emptying or
   * editing any entry changes an answer.
   */

  type Group = "accessibility" | "layouts" | "facilities";
  const GROUPS: Group[] = ["accessibility", "layouts", "facilities"];

  /** What the reader is supposed to understand: each catalogue value and the other ways people write it. */
  const PHRASEBOOK: Record<string, string[]> = {
    "Wheelchair access": ["wheelchair accessible", "wheelchair", "wheelchairs"],
    "Step-free entry": ["step-free", "step free", "stepless"],
    "Ramp access": ["ramp", "ramps"],
    "Lift access": ["lift", "lifts", "elevator", "elevators"],
    "Accessible toilets": ["accessible toilet", "accessible restroom", "accessible washroom", "disabled toilet"],
    "Accessible parking": ["disabled parking", "handicap parking"],
    "Accessible seating": ["wheelchair seating", "wheelchair spaces"],
    "Hearing loop": ["induction loop", "hearing assistance"],
    "Braille signage": ["braille"],
    "Quiet room": ["quiet space", "sensory room"],
    "Service animals welcome": ["service animal", "guide dog", "assistance dog"],
    Theatre: ["theater", "theatre-style", "theatre style", "theater-style", "theater style"],
    Classroom: ["classroom-style", "classroom style"],
    Banquet: ["banquet-style", "banquet style"],
    Cabaret: ["cabaret-style", "cabaret style"],
    Boardroom: ["boardroom-style", "boardroom style"],
    "U-shape": ["u-shaped", "u shape", "u shaped"],
    "Reception (standing)": ["reception", "standing reception", "standing room", "standing event", "standing only"],
    "Open floor": ["open-floor", "open floor plan"],
    Screen: ["projection screen", "screens"],
    "PA system": ["public address", "p.a. system", "sound system"],
    Microphones: ["microphone", "mic", "mics", "wireless mic"],
    "Lighting rig": ["stage lighting", "lighting equipment"],
    "Livestream equipment": ["livestream", "livestreaming", "live stream", "live-stream", "live streaming"],
    "Video conferencing": ["video conference", "videoconferencing", "video call", "zoom"],
    "Wi-Fi": ["wifi", "wi fi", "wireless internet", "internet access"],
    "Power outlets": ["power outlet", "power socket", "power sockets", "power point", "power points"],
    Whiteboard: ["white board"],
    "Air conditioning": ["air-conditioned", "air conditioned", "aircon", "air-con", "air con"],
    "Catering kitchen": ["kitchen"],
    "Registration desk": ["registration table", "check-in desk", "check-in counter", "reception desk"],
    Cloakroom: ["coat check"],
    "Green room": ["greenroom"],
    "Outdoor space": ["outdoor", "outdoors"],
    Parking: ["car park", "carpark"],
  };

  const groupOf = (value: string): Group => {
    const group = GROUPS.find((g) => (OPTION_CATALOGUE[g] as readonly string[]).includes(value));
    if (!group) throw new Error(`${value} is not in the catalogue`);
    return group;
  };
  const none = { accessibility: [], layouts: [], facilities: [] };
  const only = (value: string) => ({ ...none, [groupOf(value)]: [value] });

  const venueWith = (features: Partial<Record<Group, string[]>>): VenueRow => ({
    id: 1,
    name: "V",
    location: "L",
    description: null,
    capacity: 10,
    accessibility: [],
    layouts: [],
    facilities: [],
    ...features,
  });

  describe("every phrase in the phrasebook maps to its catalogue value", () => {
    const cases = Object.entries(PHRASEBOOK).flatMap(([value, phrases]) => [value.toLowerCase(), ...phrases].map((phrase) => [value, phrase] as const));

    it.each(cases)("%s <- %j", (value, phrase) => {
      expect(extractFeatures(`We will need ${phrase} please`)).toEqual(only(value));
    });

    it.each(cases)("%s <- %j, even in capitals and next to punctuation", (value, phrase) => {
      expect(extractFeatures(`(${phrase.toUpperCase()}).`)).toEqual(only(value));
    });

    it("every catalogue value has a row in this phrasebook or is deliberately absent", () => {
      const withoutAliases = Object.values(OPTION_CATALOGUE).flat().filter((value) => !(value in PHRASEBOOK));
      // These have no alternative spellings; they are matched by their own name only.
      expect(withoutAliases).toEqual(["Hollow square", "Projector", "Stage"]);
    });

    it("the catalogue name itself matches, with hyphen/space swaps and a plural", () => {
      expect(extractFeatures("projectors")).toEqual(only("Projector"));
      expect(extractFeatures("hollow-square seating")).toEqual(only("Hollow square"));
      expect(extractFeatures("hollow  square seating")).toEqual(only("Hollow square"));
      expect(extractFeatures("stages")).toEqual(only("Stage"));
    });

    it("does not match inside a longer word", () => {
      expect(extractFeatures("unstaged")).toEqual(none);
      expect(extractFeatures("projectorium")).toEqual(none);
      expect(extractFeatures("xramp")).toEqual(none);
      expect(extractFeatures("1ramp")).toEqual(none);
      expect(extractFeatures("ramp9")).toEqual(none);
    });
  });

  describe("longest phrase wins, so a shorter one inside it is not counted again", () => {
    it.each([
      ["accessible parking", only("Accessible parking")],
      ["wheelchair seating", only("Accessible seating")],
      ["reception desk", only("Registration desk")],
      ["disabled parking", only("Accessible parking")],
      ["stage lighting", only("Lighting rig")],
      ["projection screen", only("Screen")],
    ])("%s", (text, expected) => {
      expect(extractFeatures(text)).toEqual(expected);
    });

    it("but still reads the short one when it stands alone", () => {
      expect(extractFeatures("accessible parking and parking")).toEqual({ ...none, accessibility: ["Accessible parking"], facilities: ["Parking"] });
    });
  });

  describe("answers that mean 'no preference'", () => {
    it.each(["none", "None.", "N/A", "n/a", "na", "NA.", "nil", "no", "No", "nope", "-", "---", "not applicable", "no preference", "no requirement", "no requirements", "not required", "not needed", "  none  ", "", "   "])(
      "%j is no preference",
      (text) => {
        expect(isNoPreference(text)).toBe(true);
      },
    );

    it.each(["nonexistent", "no ramp", "none needed", "x none", "none x", "nope!!", "n/a ok", "no preferences", "not requiredx", "xno", "--a", "a--", "no.."])(
      "%j is not",
      (text) => {
        expect(isNoPreference(text)).toBe(false);
      },
    );

    it("anything that is not a string is no preference", () => {
      for (const value of [undefined, null, 5, {}, [], true]) expect(isNoPreference(value)).toBe(true);
    });

    it("a no-preference answer finds nothing, a longer sentence that merely starts with one is still read", () => {
      expect(extractFeatures("none")).toEqual(none);
      expect(extractFeatures("no preference, but we need a ramp")).toEqual(only("Ramp access"));
    });
  });

  describe("main features: only these filter the recommendations", () => {
    const MAIN: Record<Group, string[]> = {
      accessibility: ["Wheelchair access", "Step-free entry", "Lift access", "Accessible toilets", "Hearing loop"],
      layouts: [...OPTION_CATALOGUE.layouts],
      facilities: ["Projector", "Screen", "PA system", "Microphones", "Stage", "Lighting rig", "Livestream equipment", "Video conferencing", "Catering kitchen", "Outdoor space"],
    };
    const all = GROUPS.flatMap((group) => (OPTION_CATALOGUE[group] as readonly string[]).map((value) => [group, value] as const));

    it.each(all)("%s: %s", (group, value) => {
      const field = group === "accessibility" ? "accessibility" : group === "layouts" ? "venue" : "equipment";
      const result = extractRequirements({ [field]: value });
      const expected = MAIN[group].includes(value) ? [value] : [];
      expect(result[group]).toEqual(expected);
      for (const other of GROUPS.filter((g) => g !== group)) expect(result[other]).toEqual([]);
    });

    it("reads all four text fields and keeps the order the organiser wrote them", () => {
      const result = extractRequirements({
        venue: "Banquet",
        accessibility: "ramp, lift, wheelchair access",
        equipment: "a stage then a projector",
        technicalSupport: "live streaming",
      });
      expect(result.layouts).toEqual(["Banquet"]);
      expect(result.accessibility).toEqual(["Lift access", "Wheelchair access"]);
      expect(result.facilities).toEqual(["Stage", "Projector", "Livestream equipment"]);
    });
  });

  describe("negation", () => {
    it.each([
      "no projector",
      "not projector",
      "without a projector",
      "except the projector",
      "don't need a projector",
      "dont need a projector",
      "doesn't need a projector",
      "doesnt need a projector",
      "won't need a projector",
      "wont need a projector",
      "needn't have a projector",
      "neednt have a projector",
      "No Projector",
    ])("%j finds no projector", (text) => {
      expect(extractFeatures(text)).toEqual(none);
    });

    it("is not fooled by words that merely contain a negation word", () => {
      for (const text of ["casino projector", "nothing but a projector", "knot projector", "notable projector", "innovation projector"]) {
        expect(extractFeatures(text)).toEqual(only("Projector"));
      }
    });

    it("only looks at the last four words of the clause", () => {
      expect(extractFeatures("no a b c projector")).toEqual(none); // the negation is the 4th word back
      expect(extractFeatures("no a b c d projector")).toEqual(only("Projector")); // the 5th: out of range
    });

    it.each([".", ",", ";", ":", "!", "?", "(", ")", "\n"])("a %j ends the negation", (mark) => {
      expect(extractFeatures(`no stage${mark} projector`)).toEqual(only("Projector"));
    });

    it("negates one mention and still reads a later one", () => {
      expect(extractFeatures("no projector. we do need a projector")).toEqual(only("Projector"));
      expect(extractFeatures("no ramp, ramp needed")).toEqual(only("Ramp access"));
    });

    it("a negated feature next to a wanted one keeps only the wanted one", () => {
      expect(extractFeatures("projector but no stage")).toEqual({ ...none, facilities: ["Projector"] });
    });
  });

  describe("how the text is cleaned before it is read", () => {
    it.each(["‐", "‑", "‒", "–", "—", "―"])("treats %j as a hyphen", (dash) => {
      expect(extractFeatures(`ramp${dash}lift`)).toEqual({ ...none, accessibility: ["Ramp access", "Lift access"] });
      expect(extractFeatures(`step${dash}free`)).toEqual(only("Step-free entry"));
    });

    it("does not treat the characters just outside the dash range as hyphens", () => {
      expect(extractFeatures("ramp‏lift")).toEqual({ ...none, accessibility: ["Ramp access", "Lift access"] });
      expect(extractFeatures("step‖free")).toEqual(none);
    });

    it.each(["step  free", "step   free", "step\tfree", "step\nfree", "step \t\n free"])("collapses whitespace in %j", (text) => {
      expect(extractFeatures(text)).toEqual(only("Step-free entry"));
    });

    it("escapes punctuation inside a phrase, so it only matches what it says", () => {
      expect(extractFeatures("p.a. system")).toEqual(only("PA system"));
      expect(extractFeatures("pxax system")).toEqual(none);
      expect(extractFeatures("reception (standing)")).toEqual(only("Reception (standing)"));
    });

    it("reports features in the order they were written, not the order they were found", () => {
      expect(extractFeatures("stage, then a projector, then a screen")).toEqual({ ...none, facilities: ["Stage", "Projector", "Screen"] });
      expect(extractFeatures("screen, then a projector, then a stage")).toEqual({ ...none, facilities: ["Screen", "Projector", "Stage"] });
    });

    it("lists a feature once however often it is mentioned", () => {
      expect(extractFeatures("ramp, ramp and ramps")).toEqual(only("Ramp access"));
    });
  });

  describe("features that only a venue lists", () => {
    it("recognises a venue-specific feature, in the venue's own spelling", () => {
      const venue = venueWith({ facilities: ["Karaoke machine"], layouts: ["Rock-pit"], accessibility: ["Signing booth"] });
      expect(extractFeatures("karaoke machines, a rock pit and a signing booth", [venue])).toEqual({
        accessibility: ["Signing booth"],
        layouts: ["Rock-pit"],
        facilities: ["Karaoke machine"],
      });
      // Without that venue the same words mean nothing.
      expect(extractFeatures("karaoke machines, a rock pit and a signing booth")).toEqual(none);
    });

    it("when a venue spells a catalogue value differently the catalogue spelling is reported", () => {
      const venue = venueWith({ accessibility: ["WHEELCHAIR ACCESS"], facilities: ["PROJECTOR"] });
      expect(extractFeatures("wheelchair access and a projector", [venue])).toEqual({
        accessibility: ["Wheelchair access"],
        layouts: [],
        facilities: ["Projector"],
      });
    });

  });

  describe("withFeatures", () => {
    const requirements = { attendance: null, date: null, startTime: null, endTime: null, accessibility: ["Ramp access"], layouts: [], facilities: [] };

    it("adds only the groups that have something, and leaves no empty key behind", () => {
      const next = withFeatures({ q: "hall" }, requirements);
      expect(next).toStrictEqual({ q: "hall", accessibility: ["Ramp access"] });
      expect(Object.keys(next)).toEqual(["q", "accessibility"]);
    });

    it("does not change the criteria it was given", () => {
      const criteria = { q: "hall" };
      withFeatures(criteria, requirements);
      expect(criteria).toStrictEqual({ q: "hall" });
    });

    it("a group with nothing leaves the caller's own filter for it alone", () => {
      expect(withFeatures({ layouts: ["Banquet"] }, requirements)).toStrictEqual({ layouts: ["Banquet"], accessibility: ["Ramp access"] });
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
});

describe("event ids", () => {
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
});
