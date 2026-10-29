/**
 * E4-17: what one venue booking of an event is for, and whether a venue
 * suits it. A multi-venue event (§3a change 3) books a main hall for
 * everyone and smaller rooms for sessions, so each booking is judged on its
 * own headcount and needs rather than on the whole event's attendance.
 *
 * Bookings made before E4-17 carry no plan; `effectivePlan` reads them as
 * the main programme for the full attendance with the event's own
 * requirements — exactly what E4-7/E4-8 judged them against.
 */
import { extractRequirements, type EventRequirementDetails } from "./venueRecommendation.js";
import type { VenueRow } from "./venueSearch.js";

/** Fixed list (migration 0034's check constraint mirrors it). */
export const BOOKING_PURPOSES = ["Main programme", "Breakout", "Registration", "Catering", "Other"] as const;
export type BookingPurpose = (typeof BOOKING_PURPOSES)[number];

export const DEFAULT_PURPOSE: BookingPurpose = "Main programme";
const MAX_PURPOSE_DETAIL_LENGTH = 80;

export type FeatureGroup = "layouts" | "facilities" | "accessibility";
export const FEATURE_GROUPS: readonly FeatureGroup[] = ["layouts", "facilities", "accessibility"];

export type Requirements = Record<FeatureGroup, string[]>;

export interface BookingPlan {
  purpose: BookingPurpose;
  /** Only for "Other": what the venue is for. */
  purposeDetail: string | null;
  headcount: number;
  requirements: Requirements;
}

/** The plan as stored on a venue_bookings row; null columns predate E4-17. */
export interface BookingPlanColumns {
  purpose: string | null;
  purpose_detail: string | null;
  headcount: number | null;
  required_layouts: string[] | null;
  required_facilities: string[] | null;
  required_accessibility: string[] | null;
}

/** Request/query keys that make up a plan. An empty `layouts=` means "none needed". */
const BOOKING_PLAN_KEYS = ["purpose", "purposeDetail", "headcount", "layouts", "facilities", "accessibility"];

/** Whether a request body or query carries any part of a plan. */
export function hasPlan(raw: Record<string, unknown>): boolean {
  return BOOKING_PLAN_KEYS.some((key) => raw[key] !== undefined);
}

export const BOOKING_PLAN_COLUMNS =
  "purpose, purpose_detail, headcount, required_layouts, required_facilities, required_accessibility";

/** What the event itself asks for — the default for every booking. */
export interface EventDefaults {
  /** null when the event never gave a usable attendance. */
  attendance: number | null;
  requirements: Requirements;
}

/**
 * Q1 (team decision): pre-filled from the event's current details — by the
 * time a venue can be requested (Planning) those include every agreed
 * clarification and edit. Same reading as E4-7's recommendations.
 */
export function eventDefaults(details: EventRequirementDetails, venues: VenueRow[]): EventDefaults {
  const r = extractRequirements(details, venues);
  return {
    attendance: r.attendance,
    requirements: { layouts: r.layouts, facilities: r.facilities, accessibility: r.accessibility },
  };
}

export type ParsedPlan = { valid: true; plan: BookingPlan } | { valid: false; fields: Record<string, string> };

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** A whole number given as a number or a plain digit string; null otherwise. */
function wholeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return /^-?\d+$/.test(text) ? Number(text) : null;
}

/** Trimmed, de-duplicated strings; one value or several (query strings repeat keys). */
function stringList(value: unknown): string[] | null {
  const items = Array.isArray(value) ? value : [value];
  if (items.some((item) => typeof item !== "string")) return null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items as string[]) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    result.push(trimmed);
  }
  return result;
}

/**
 * AC1/AC6: a booking's plan from a request body (or recommendations query).
 * Everything is optional: a missing purpose is the main programme, a
 * missing headcount is the event's whole attendance (AC6 — a single-venue
 * event behaves exactly as before E4-17), and a missing requirement list is
 * the event's own. A headcount that is given must be 1..attendance.
 */
export function parseBookingPlan(raw: Record<string, unknown>, defaults: EventDefaults): ParsedPlan {
  const fields: Record<string, string> = {};

  let purpose: BookingPurpose = DEFAULT_PURPOSE;
  if (!isBlank(raw.purpose)) {
    const match = BOOKING_PURPOSES.find((p) => typeof raw.purpose === "string" && p.toLowerCase() === raw.purpose.trim().toLowerCase());
    if (match) purpose = match;
    else fields.purpose = `Choose one of: ${BOOKING_PURPOSES.join(", ")}.`;
  }

  let purposeDetail: string | null = null;
  if (purpose === "Other") {
    purposeDetail = typeof raw.purposeDetail === "string" ? raw.purposeDetail.trim() : "";
    if (!purposeDetail) fields.purposeDetail = "Say what this venue is for.";
    else if (purposeDetail.length > MAX_PURPOSE_DETAIL_LENGTH) {
      fields.purposeDetail = `Keep it to ${MAX_PURPOSE_DETAIL_LENGTH} characters.`;
    }
  }

  let headcount = defaults.attendance ?? 0;
  if (isBlank(raw.headcount)) {
    if (defaults.attendance === null) fields.headcount = "Enter the expected headcount for this venue.";
  } else {
    const n = wholeNumber(raw.headcount);
    if (n === null || n < 1) fields.headcount = "The headcount must be a whole number of at least 1.";
    else if (defaults.attendance !== null && n > defaults.attendance) {
      fields.headcount = `The headcount can't be more than the event's expected attendance (${defaults.attendance}).`;
    } else headcount = n;
  }

  const requirements = { ...defaults.requirements };
  for (const group of FEATURE_GROUPS) {
    const list = stringList(raw[group]);
    if (raw[group] !== undefined && list === null) fields[group] = "Send a list of options.";
    else if (list !== null) requirements[group] = list;
  }

  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return { valid: true, plan: { purpose, purposeDetail, headcount, requirements } };
}

/** The columns to store for a plan. */
export function toPlanColumns(plan: BookingPlan): BookingPlanColumns {
  return {
    purpose: plan.purpose,
    purpose_detail: plan.purposeDetail,
    headcount: plan.headcount,
    required_layouts: plan.requirements.layouts,
    required_facilities: plan.requirements.facilities,
    required_accessibility: plan.requirements.accessibility,
  };
}

/** A stored booking's plan, with anything missing read as the event's (see the header). */
export type EffectivePlan = Omit<BookingPlan, "headcount"> & {
  /** null only for a pre-E4-17 booking on an event with no usable attendance. */
  headcount: number | null;
};

export function effectivePlan(row: Partial<BookingPlanColumns>, defaults: EventDefaults): EffectivePlan {
  const purpose = BOOKING_PURPOSES.find((p) => p === row.purpose) ?? DEFAULT_PURPOSE;
  return {
    purpose,
    purposeDetail: purpose === "Other" ? (row.purpose_detail ?? null) : null,
    headcount: row.headcount ?? defaults.attendance,
    requirements: {
      layouts: row.required_layouts ?? defaults.requirements.layouts,
      facilities: row.required_facilities ?? defaults.requirements.facilities,
      accessibility: row.required_accessibility ?? defaults.requirements.accessibility,
    },
  };
}

/** A main-programme booking in one of these still covers the event's main venue. */
export const MAIN_HOLDING_STATUSES: readonly string[] = ["Requested", "On Hold", "Approved"];

/**
 * Whether the event's main venue is already covered. The main programme is
 * booked first; once it is, every later booking is for part of the event
 * and must say what (AC1). A main venue that needs replacing, or was
 * withdrawn or rejected, no longer counts — its replacement is the main
 * programme again (E4-15).
 */
export function holdsMainProgramme(
  bookings: (Partial<BookingPlanColumns> & { status: string })[],
  defaults: EventDefaults,
): boolean {
  return bookings.some(
    (b) => MAIN_HOLDING_STATUSES.includes(b.status) && effectivePlan(b, defaults).purpose === DEFAULT_PURPOSE,
  );
}

/** "Breakout" or, for Other, what was typed. */
export function purposeLabel(plan: Pick<BookingPlan, "purpose" | "purposeDetail">): string {
  return plan.purpose === "Other" && plan.purposeDetail ? plan.purposeDetail : plan.purpose;
}

export type SuitabilityReason =
  | { kind: "capacity"; capacity: number; headcount: number }
  | { kind: FeatureGroup; missing: string[] };

export interface Suitability {
  suitable: boolean;
  reasons: SuitabilityReason[];
}

/**
 * AC2–AC4: does `venue` suit this booking? Capacity must be at least the
 * headcount (equal is fine, AC3), and the venue must have every layout,
 * facility and accessibility feature the booking needs (compared
 * case-insensitively, as venue search does). An unknown headcount (an old
 * booking on an event with no attendance) can't fail on capacity.
 */
export function checkSuitability(
  venue: Pick<VenueRow, "capacity" | "layouts" | "facilities" | "accessibility">,
  plan: { headcount: number | null; requirements: Requirements },
): Suitability {
  const reasons: SuitabilityReason[] = [];
  if (plan.headcount !== null && venue.capacity < plan.headcount) {
    reasons.push({ kind: "capacity", capacity: venue.capacity, headcount: plan.headcount });
  }
  for (const group of FEATURE_GROUPS) {
    const have = new Set(venue[group]?.map((value) => value.toLowerCase()));
    const missing = plan.requirements[group].filter((value) => !have.has(value.toLowerCase()));
    if (missing.length > 0) reasons.push({ kind: group, missing });
  }
  return { suitable: reasons.length === 0, reasons };
}
