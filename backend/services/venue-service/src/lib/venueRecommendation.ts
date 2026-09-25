/**
 * E4 venue recommendations: turn an event request's requirements into
 * venue-search criteria, so "recommended" means exactly "passes the same
 * all-criteria match as venue search" (lib/venueSearch.ts).
 *
 * The organiser describes venue needs as free text (venue / accessibility /
 * equipment / technicalSupport). Venues list their features as structured
 * values, so the text is scanned for those values — plus a few common
 * phrasings of each ("wheelchair-accessible" → "Wheelchair access"). A
 * field that says "NA"/"None"/etc. is no preference; so is any wording that
 * names no venue feature (e.g. "sign-language interpreter" is staffing, not
 * something a venue has).
 *
 * The extracted requirements are returned alongside the recommendations so
 * the coordinator can see exactly what each venue was checked against.
 */

import { OPTION_CATALOGUE, type VenueRow, type VenueSearchCriteria } from "./venueSearch.js";

export type FeatureGroup = "accessibility" | "layouts" | "facilities";

export interface EventRequirementDetails {
  proposedDate?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  expectedAttendance?: unknown;
  venue?: unknown;
  accessibility?: unknown;
  equipment?: unknown;
  technicalSupport?: unknown;
}

export interface ExtractedRequirements {
  attendance: number | null;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  accessibility: string[];
  layouts: string[];
  facilities: string[];
}

/** Free-text fields scanned for venue features. */
const REQUIREMENT_TEXT_FIELDS = ["venue", "accessibility", "equipment", "technicalSupport"] as const;

/** Whole-field answers that mean "no preference". */
const NO_PREFERENCE_PATTERN =
  /^(n\/?a|nil|none|no|nope|-+|not applicable|no preference|no requirements?|not required|not needed)\.?$/i;

/**
 * Other ways organisers write each catalogue value. The catalogue value
 * itself always matches, so only genuine alternatives belong here.
 */
const ALIASES: Record<string, string[]> = {
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
  // "reception desk" is here so it isn't read as the Reception layout.
  "Registration desk": ["registration table", "check-in desk", "check-in counter", "reception desk"],
  Cloakroom: ["coat check"],
  "Green room": ["greenroom"],
  "Outdoor space": ["outdoor", "outdoors"],
  Parking: ["car park", "carpark"],
};

/** "no projector", "without a stage", "don't need mics" — within the same clause. */
const NEGATION_PATTERN = /\b(no|not|without|except|don'?t need|doesn'?t need|won'?t need|needn'?t)\b/;

interface Term {
  group: FeatureGroup;
  value: string;
  pattern: RegExp;
  length: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches the phrase as whole words, tolerating "-"/" " swaps and a plural. */
function phrasePattern(phrase: string): RegExp {
  const body = phrase
    .toLowerCase()
    .split(/[\s-]+/)
    .map(escapeRegExp)
    .join("[\\s-]?");
  return new RegExp(`(?<![a-z0-9])${body}(?:s|es)?(?![a-z0-9])`, "g");
}

/**
 * Every phrase that maps to a venue feature: the standard catalogue with
 * its aliases, plus any extra value a venue lists (so a venue-specific
 * feature like "Karaoke machine" is recognised without editing this file).
 * Longest phrases first, so "accessible parking" wins over "parking".
 */
function buildTerms(venues: VenueRow[]): Term[] {
  const values = new Map<string, { group: FeatureGroup; value: string }>();
  const add = (group: FeatureGroup, value: string) => {
    const key = `${group}:${value.toLowerCase()}`;
    if (!values.has(key)) values.set(key, { group, value });
  };

  for (const group of ["accessibility", "layouts", "facilities"] as const) {
    for (const value of OPTION_CATALOGUE[group]) add(group, value);
    for (const venue of venues) for (const value of venue[group]) add(group, value);
  }

  const terms: Term[] = [];
  for (const { group, value } of values.values()) {
    for (const phrase of [value, ...(ALIASES[value] ?? [])]) {
      terms.push({ group, value, pattern: phrasePattern(phrase), length: phrase.length });
    }
  }
  return terms.sort((a, b) => b.length - a.length);
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[‐-―]/g, "-").replace(/\s+/g, " ");
}

function isNegated(text: string, matchIndex: number): boolean {
  const before = text.slice(0, matchIndex);
  const clauseStart = Math.max(...[".", ",", ";", ":", "!", "?", "(", ")", "\n"].map((c) => before.lastIndexOf(c)));
  const lastWords = before.slice(clauseStart + 1).trim().split(/\s+/).slice(-4).join(" ");
  return NEGATION_PATTERN.test(lastWords);
}

export function isNoPreference(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  return trimmed === "" || NO_PREFERENCE_PATTERN.test(trimmed);
}

/** Venue features named in one piece of free text. */
export function extractFeatures(text: string, venues: VenueRow[] = []): Record<FeatureGroup, string[]> {
  const found: Record<FeatureGroup, string[]> = { accessibility: [], layouts: [], facilities: [] };
  if (isNoPreference(text)) return found;

  const hits: { group: FeatureGroup; value: string; offset: number }[] = [];
  let remaining = normalise(text);
  for (const term of buildTerms(venues)) {
    remaining = remaining.replace(term.pattern, (match, offset: number) => {
      if (!isNegated(remaining, offset)) hits.push({ group: term.group, value: term.value, offset });
      // Blank the span so a shorter phrase inside it ("parking" inside
      // "accessible parking") isn't counted a second time.
      return " ".repeat(match.length);
    });
  }

  // Report in the order the organiser wrote them.
  for (const hit of hits.sort((a, b) => a.offset - b.offset)) {
    if (!found[hit.group].includes(hit.value)) found[hit.group].push(hit.value);
  }
  return found;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export function extractRequirements(details: EventRequirementDetails, venues: VenueRow[] = []): ExtractedRequirements {
  const features: Record<FeatureGroup, Set<string>> = {
    accessibility: new Set(),
    layouts: new Set(),
    facilities: new Set(),
  };
  for (const field of REQUIREMENT_TEXT_FIELDS) {
    const text = details[field];
    if (typeof text !== "string") continue;
    const found = extractFeatures(text, venues);
    for (const group of ["accessibility", "layouts", "facilities"] as const) {
      for (const value of found[group]) features[group].add(value);
    }
  }

  const attendance = Number(details.expectedAttendance);

  return {
    // Seats come in whole numbers: 150.5 people need a 151-seat venue.
    attendance: Number.isFinite(attendance) && attendance > 0 ? Math.ceil(attendance) : null,
    date: readString(details.proposedDate),
    startTime: readString(details.startTime),
    endTime: readString(details.endTime),
    accessibility: [...features.accessibility],
    layouts: [...features.layouts],
    facilities: [...features.facilities],
  };
}

/** Raw query for parseVenueSearch, so the schedule is validated the same way a search is. */
export function scheduleQuery(requirements: ExtractedRequirements): Record<string, string> {
  const query: Record<string, string> = {};
  if (requirements.attendance !== null) query.attendance = String(requirements.attendance);
  if (requirements.date) query.date = requirements.date;
  if (requirements.date && requirements.startTime && requirements.endTime) {
    query.startTime = requirements.startTime;
    query.endTime = requirements.endTime;
  }
  return query;
}

export function withFeatures(criteria: VenueSearchCriteria, requirements: ExtractedRequirements): VenueSearchCriteria {
  const next = { ...criteria };
  for (const group of ["accessibility", "layouts", "facilities"] as const) {
    if (requirements[group].length > 0) next[group] = requirements[group];
  }
  return next;
}
