/**
 * Venue search: query parsing and matching, kept free of Express/Supabase
 * so the acceptance criteria can be unit-tested directly.
 *
 * Matching semantics (AC1: "every venue shown satisfies all selected
 * criteria"):
 *   - Each criterion the coordinator sets is ANDed with every other.
 *   - accessibility/layouts/facilities: the venue must have ALL selected
 *     values — picking "Projector" and "Stage" means both are needed.
 *   - locations: a venue is in exactly one location, so selecting several
 *     means "any of these" (ALL would always be empty).
 *   - attendance: the venue must fit everyone (capacity >= attendance).
 *   - capacityMin/capacityMax: an explicit capacity band, e.g. to rule out
 *     a 600-seat hall for a 40-person seminar.
 *   - date (+ optional time window): the venue must have no booking
 *     overlapping it (AC2). A date with no times blocks on any booking
 *     that day.
 */

export interface VenueRow {
  id: number;
  name: string;
  location: string;
  description: string | null;
  capacity: number;
  accessibility: string[];
  layouts: string[];
  facilities: string[];
}

export interface VenueSearchCriteria {
  q?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  attendance?: number;
  capacityMin?: number;
  capacityMax?: number;
  locations?: string[];
  accessibility?: string[];
  layouts?: string[];
  facilities?: string[];
}

/** One criterion the coordinator could drop to get results back (AC3). */
export type CriterionKey =
  | "q"
  | "availability"
  | "attendance"
  | "capacity"
  | "locations"
  | "accessibility"
  | "layouts"
  | "facilities";

export interface RelaxOption {
  key: CriterionKey;
  label: string;
  /** How many venues would match if only this criterion were removed. */
  count: number;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

type RawQuery = Record<string, unknown>;

function readString(query: RawQuery, key: string): string | undefined {
  const raw = query[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Accepts `?facilities=A&facilities=B` and `?facilities=A,B` alike. */
function readList(query: RawQuery, key: string): string[] | undefined {
  const raw = query[key];
  const values = (Array.isArray(raw) ? raw : [raw])
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

export function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export type ParseResult =
  | { valid: true; criteria: VenueSearchCriteria }
  | { valid: false; fields: Record<string, string> };

export function parseVenueSearch(query: RawQuery): ParseResult {
  const fields: Record<string, string> = {};
  const criteria: VenueSearchCriteria = {};

  const q = readString(query, "q");
  if (q) criteria.q = q;

  const date = readString(query, "date");
  const startTime = readString(query, "startTime");
  const endTime = readString(query, "endTime");

  if (date !== undefined) {
    if (isRealDate(date)) criteria.date = date;
    else fields.date = "Date must be a valid date (YYYY-MM-DD)";
  }
  if (startTime !== undefined) {
    if (TIME_PATTERN.test(startTime)) criteria.startTime = startTime;
    else fields.startTime = "Start time must be HH:MM";
  }
  if (endTime !== undefined) {
    if (TIME_PATTERN.test(endTime)) criteria.endTime = endTime;
    else fields.endTime = "End time must be HH:MM";
  }
  if ((startTime || endTime) && !date) {
    fields.date = "Pick a date to search by time";
  }
  if ((startTime && !endTime) || (!startTime && endTime)) {
    fields.endTime = "Give both a start and an end time";
  }
  if (criteria.startTime && criteria.endTime && criteria.endTime <= criteria.startTime) {
    fields.endTime = "End time must be after start time";
  }

  for (const key of ["attendance", "capacityMin", "capacityMax"] as const) {
    const raw = readString(query, key);
    if (raw === undefined) continue;
    if (POSITIVE_INTEGER_PATTERN.test(raw)) criteria[key] = Number(raw);
    else fields[key] = "Must be a whole number greater than 0";
  }
  if (
    criteria.capacityMin !== undefined &&
    criteria.capacityMax !== undefined &&
    criteria.capacityMin > criteria.capacityMax
  ) {
    fields.capacityMax = "Maximum capacity must be at least the minimum";
  }

  for (const key of ["locations", "accessibility", "layouts", "facilities"] as const) {
    const list = readList(query, key);
    if (list) criteria[key] = list;
  }

  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, criteria };
}

function hasAll(have: string[], want: string[] | undefined): boolean {
  if (!want || want.length === 0) return true;
  const set = new Set(have.map((v) => v.toLowerCase()));
  return want.every((v) => set.has(v.toLowerCase()));
}

function matchesText(venue: VenueRow, q: string): boolean {
  const needle = q.toLowerCase();
  return [venue.name, venue.location, venue.description ?? ""].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

/**
 * Tests a single criterion. `unavailableVenueIds` is the set of venues
 * with a booking overlapping the requested window — resolved by the route
 * with a DB query, since bookings aren't part of the venue row.
 */
function passes(
  key: CriterionKey,
  venue: VenueRow,
  criteria: VenueSearchCriteria,
  unavailableVenueIds: Set<number>,
): boolean {
  switch (key) {
    case "q":
      return !criteria.q || matchesText(venue, criteria.q);
    case "availability":
      return !criteria.date || !unavailableVenueIds.has(venue.id);
    case "attendance":
      return criteria.attendance === undefined || venue.capacity >= criteria.attendance;
    case "capacity":
      return (
        (criteria.capacityMin === undefined || venue.capacity >= criteria.capacityMin) &&
        (criteria.capacityMax === undefined || venue.capacity <= criteria.capacityMax)
      );
    case "locations":
      return (
        !criteria.locations ||
        criteria.locations.some((loc) => loc.toLowerCase() === venue.location.toLowerCase())
      );
    case "accessibility":
      return hasAll(venue.accessibility, criteria.accessibility);
    case "layouts":
      return hasAll(venue.layouts, criteria.layouts);
    case "facilities":
      return hasAll(venue.facilities, criteria.facilities);
  }
}

const ALL_CRITERIA: CriterionKey[] = [
  "q",
  "availability",
  "attendance",
  "capacity",
  "locations",
  "accessibility",
  "layouts",
  "facilities",
];

const CRITERION_LABELS: Record<CriterionKey, string> = {
  q: "Search text",
  availability: "Date & time",
  attendance: "Attendance",
  capacity: "Capacity",
  locations: "Location",
  accessibility: "Accessibility",
  layouts: "Layout",
  facilities: "Facilities",
};

export function activeCriteria(criteria: VenueSearchCriteria): CriterionKey[] {
  return ALL_CRITERIA.filter((key) => {
    switch (key) {
      case "q":
        return !!criteria.q;
      case "availability":
        return !!criteria.date;
      case "attendance":
        return criteria.attendance !== undefined;
      case "capacity":
        return criteria.capacityMin !== undefined || criteria.capacityMax !== undefined;
      default:
        return !!criteria[key]?.length;
    }
  });
}

function matchesAll(
  venue: VenueRow,
  criteria: VenueSearchCriteria,
  unavailableVenueIds: Set<number>,
  keys: CriterionKey[],
): boolean {
  return keys.every((key) => passes(key, venue, criteria, unavailableVenueIds));
}

export interface VenueSearchResult {
  venues: VenueRow[];
  /** Only populated when nothing matched (AC3): the single criteria whose
   * removal would bring results back, most results first. */
  relax: RelaxOption[];
}

export function searchVenues(
  venues: VenueRow[],
  criteria: VenueSearchCriteria,
  unavailableVenueIds: Set<number>,
): VenueSearchResult {
  const active = activeCriteria(criteria);
  const matched = venues
    .filter((venue) => matchesAll(venue, criteria, unavailableVenueIds, active))
    .sort((a, b) => a.capacity - b.capacity || a.name.localeCompare(b.name));

  if (matched.length > 0 || active.length === 0) {
    return { venues: matched, relax: [] };
  }

  const relax = active
    .map((dropped) => {
      const remaining = active.filter((key) => key !== dropped);
      const count = venues.filter((venue) => matchesAll(venue, criteria, unavailableVenueIds, remaining)).length;
      return { key: dropped, label: CRITERION_LABELS[dropped], count };
    })
    .filter((option) => option.count > 0)
    .sort((a, b) => b.count - a.count);

  return { venues: matched, relax };
}

export interface VenueFilterOptions {
  locations: string[];
  accessibility: string[];
  layouts: string[];
  facilities: string[];
  capacity: { min: number; max: number } | null;
}

/**
 * Standard options offered in the filter dropdowns even before any venue
 * lists them, so coordinators can tick from a familiar set rather than
 * only what happens to be in the table today. Values venues actually use
 * are merged in on top (see buildFilterOptions), so a new facility added
 * to a venue shows up without editing this list.
 */
export const OPTION_CATALOGUE = {
  accessibility: [
    "Wheelchair access",
    "Step-free entry",
    "Ramp access",
    "Lift access",
    "Accessible toilets",
    "Accessible parking",
    "Accessible seating",
    "Hearing loop",
    "Braille signage",
    "Quiet room",
    "Service animals welcome",
  ],
  layouts: [
    "Theatre",
    "Classroom",
    "Banquet",
    "Cabaret",
    "Boardroom",
    "U-shape",
    "Hollow square",
    "Reception (standing)",
    "Open floor",
  ],
  facilities: [
    "Projector",
    "Screen",
    "PA system",
    "Microphones",
    "Stage",
    "Lighting rig",
    "Livestream equipment",
    "Video conferencing",
    "Wi-Fi",
    "Power outlets",
    "Whiteboard",
    "Air conditioning",
    "Catering kitchen",
    "Registration desk",
    "Cloakroom",
    "Green room",
    "Outdoor space",
    "Parking",
  ],
} as const;

/** Filter-bar option lists: the standard catalogue plus any extra values venues use. */
export function buildFilterOptions(venues: VenueRow[]): VenueFilterOptions {
  const collect = (pick: (v: VenueRow) => string[], catalogue: readonly string[] = []) => {
    const seen = new Set(catalogue.map((v) => v.toLowerCase()));
    const extras = [...new Set(venues.flatMap(pick))]
      .filter((v) => !seen.has(v.toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
    // Catalogue keeps its deliberate order (related options together);
    // anything venue-specific follows alphabetically.
    return [...catalogue, ...extras];
  };

  const capacities = venues.map((v) => v.capacity);

  return {
    locations: collect((v) => [v.location]),
    accessibility: collect((v) => v.accessibility, OPTION_CATALOGUE.accessibility),
    layouts: collect((v) => v.layouts, OPTION_CATALOGUE.layouts),
    facilities: collect((v) => v.facilities, OPTION_CATALOGUE.facilities),
    capacity: capacities.length > 0 ? { min: Math.min(...capacities), max: Math.max(...capacities) } : null,
  };
}
