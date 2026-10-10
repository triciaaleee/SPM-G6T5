/**
 * E4-1: venue staff create and update venue records. Validation lives here
 * so creating and updating share exactly the same rules.
 *
 * Field names match the frontend form (camelCase); `toVenueColumns` maps
 * them onto the venues table (migrations 0011, 0018, 0019).
 */

export interface VenueInput {
  name: string;
  location: string;
  description: string | null;
  capacity: number;
  accessibility: string[];
  layouts: string[];
  facilities: string[];
  setupMinutes: number;
  turnaroundMinutes: number;
  openingTime: string;
  closingTime: string;
}

export type ParsedVenueInput =
  | { valid: true; venue: VenueInput }
  | {
      valid: false;
      fields: Record<string, string>;
      /** AC2: the mandatory attributes that are missing, by name. */
      missing: string[];
    };

/** "24:00" is allowed for a venue open until midnight (migration 0019). */
const TIME_PATTERN = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1000;
/** A day's worth of setup or turnaround is already more than any event needs. */
const MAX_BUFFER_MINUTES = 24 * 60;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** Non-empty, trimmed, de-duplicated (case-insensitively) strings — or null if the value isn't a string array. */
function stringList(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value as string[]) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    result.push(trimmed);
  }
  return result;
}

/** A whole number given as a number or a plain digit string; null for anything else ("abc", "1.5", "1e2"). */
function wholeNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function parseVenueInput(body: unknown): ParsedVenueInput {
  const raw = (body ?? {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const missing: string[] = [];

  const name = text(raw.name);
  if (!name) {
    fields.name = "Enter the venue's name.";
    missing.push("name");
  } else if (name.length > MAX_NAME_LENGTH) fields.name = `Keep the name to ${MAX_NAME_LENGTH} characters.`;

  const location = text(raw.location);
  if (!location) {
    fields.location = "Enter where the venue is.";
    missing.push("location");
  }

  const description = text(raw.description);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    fields.description = `Keep the description to ${MAX_DESCRIPTION_LENGTH} characters.`;
  }

  // AC5: zero or less is blocked, as is anything that isn't a whole number.
  const capacity = wholeNumber(raw.capacity);
  if (isBlank(raw.capacity)) {
    fields.capacity = "Enter the maximum capacity.";
    missing.push("maximum capacity");
  } else if (capacity === null || capacity < 1) fields.capacity = "Capacity must be a whole number of at least 1.";

  // AC3/AC4: whole minutes, 0 allowed; negative or non-numeric is blocked.
  // Left blank they're 0 — the column default — since they aren't on AC1's mandatory list.
  const buffer = (key: "setupMinutes" | "turnaroundMinutes", label: string): number => {
    if (isBlank(raw[key])) return 0;
    const minutes = wholeNumber(raw[key]);
    if (minutes === null || minutes < 0 || minutes > MAX_BUFFER_MINUTES) {
      fields[key] = `Enter ${label} in whole minutes, from 0 to ${MAX_BUFFER_MINUTES}.`;
      return 0;
    }
    return minutes;
  };
  const setupMinutes = buffer("setupMinutes", "the setup time");
  const turnaroundMinutes = buffer("turnaroundMinutes", "the turnaround time");

  const openingTime = text(raw.openingTime);
  const closingTime = text(raw.closingTime);
  if (!openingTime || !closingTime) missing.push("operating hours");
  if (!openingTime) fields.openingTime = "Enter an opening time.";
  else if (!TIME_PATTERN.test(openingTime)) fields.openingTime = "Enter the opening time as HH:MM.";
  if (!closingTime) fields.closingTime = "Enter a closing time.";
  else if (!TIME_PATTERN.test(closingTime)) fields.closingTime = "Enter the closing time as HH:MM.";
  else if (!fields.openingTime && closingTime <= openingTime) {
    fields.closingTime = "The closing time must be after the opening time.";
  }

  const lists = {} as Record<"accessibility" | "layouts" | "facilities", string[]>;
  const LIST_LABELS = {
    layouts: ["supported layouts", "Choose at least one supported layout."],
    facilities: ["facilities", "Choose at least one facility."],
    accessibility: ["accessibility features", "Choose at least one accessibility feature, or \"No accessibility features\"."],
  } as const;
  // A venue with genuinely no accessibility features says so explicitly
  // (stored as an empty list, so it never matches an accessibility filter);
  // leaving the section blank is still a missing attribute.
  const noAccessibilityFeatures = raw.noAccessibilityFeatures === true;
  for (const key of ["layouts", "facilities", "accessibility"] as const) {
    const list = stringList(raw[key]);
    if (list === null) fields[key] = "Send a list of options.";
    else if (key === "accessibility" && noAccessibilityFeatures) {
      if (list.length > 0) fields[key] = "Choose accessibility features or \"No accessibility features\", not both.";
    } else if (list.length === 0) {
      fields[key] = LIST_LABELS[key][1];
      missing.push(LIST_LABELS[key][0]);
    }
    lists[key] = list ?? [];
  }

  if (Object.keys(fields).length > 0) return { valid: false, fields, missing };

  return {
    valid: true,
    venue: {
      name,
      location,
      description: description || null,
      capacity: capacity!,
      ...lists,
      setupMinutes,
      turnaroundMinutes,
      openingTime,
      closingTime,
    },
  };
}

/** AC2: the error message names every missing mandatory attribute. */
export function invalidVenueMessage(missing: string[]): string {
  return missing.length > 0 ? `Missing required details: ${missing.join(", ")}` : "Some venue details are invalid";
}

/** The venues table's column names for a validated input. */
export function toVenueColumns(venue: VenueInput) {
  return {
    name: venue.name,
    location: venue.location,
    description: venue.description,
    capacity: venue.capacity,
    accessibility: venue.accessibility,
    layouts: venue.layouts,
    facilities: venue.facilities,
    setup_minutes: venue.setupMinutes,
    turnaround_minutes: venue.turnaroundMinutes,
    opening_time: venue.openingTime,
    closing_time: venue.closingTime,
  };
}

/** A venues row as the edit form needs it. Times may come back from Postgres as "HH:MM:SS". */
export interface VenueRecordRow {
  id: number;
  name: string;
  location: string;
  description: string | null;
  capacity: number;
  accessibility: string[] | null;
  layouts: string[] | null;
  facilities: string[] | null;
  setup_minutes: number | null;
  turnaround_minutes: number | null;
  opening_time: string | null;
  closing_time: string | null;
  status: string;
}

export const VENUE_RECORD_COLUMNS =
  "id, name, location, description, capacity, accessibility, layouts, facilities, setup_minutes, turnaround_minutes, opening_time, closing_time, status";

export function toVenueRecord(row: VenueRecordRow) {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    description: row.description ?? "",
    capacity: row.capacity,
    accessibility: row.accessibility ?? [],
    layouts: row.layouts ?? [],
    facilities: row.facilities ?? [],
    setupMinutes: row.setup_minutes ?? 0,
    turnaroundMinutes: row.turnaround_minutes ?? 0,
    openingTime: (row.opening_time ?? "08:00").slice(0, 5),
    closingTime: (row.closing_time ?? "22:00").slice(0, 5),
    status: row.status,
  };
}
