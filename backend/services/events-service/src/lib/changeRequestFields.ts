import type { ValidatedEventRequest } from "./validateEventRequest.js";
import { clock } from "./clock.js";

/**
 * E3-8: fields held for the assigned coordinator's review rather than
 * applied immediately, once an event is Confirmed (E3-9). Same base set as
 * COORDINATOR_LOCKED_FIELDS (E3-7, events.ts) plus equipment and
 * accessibility — one list, reused from both call sites' intent ("changes
 * to arrangements already made need reassessment").
 */
export const CRITICAL_CHANGE_FIELDS = [
  "proposedDate",
  "startTime",
  "endTime",
  "expectedAttendance",
  "venue",
  "equipment",
  "accessibility",
] as const;

export type CriticalChangeField = (typeof CRITICAL_CHANGE_FIELDS)[number];

const CRITICAL_FIELD_SET: ReadonlySet<string> = new Set(CRITICAL_CHANGE_FIELDS);

export function isCriticalField(field: string): boolean {
  return CRITICAL_FIELD_SET.has(field);
}

/** Only the fields a change request is allowed to carry — the full set validateEventRequest knows about. */
const EDITABLE_FIELDS = [
  "name",
  "purpose",
  "description",
  "proposedDate",
  "startTime",
  "endTime",
  "expectedAttendance",
  "venue",
  "accessibility",
  "equipment",
  "technicalSupport",
  "registrationNeeded",
] as const;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function todayIsoDate(): string {
  return clock.now().toISOString().slice(0, 10);
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function formatValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/**
 * E3-9: the true committed baseline for a field — what's actually live in
 * submitted_details, ignoring any held/pending value. Used to tell a
 * genuine overwrite of a held field from a revert back to what's already
 * there (events.ts's merge logic), and to label a held field's `oldValue`
 * so it always reads against reality, not against an earlier pending
 * value that was itself never applied.
 */
export function committedFieldValue(current: Partial<ValidatedEventRequest>, field: string): string | null {
  const value = (current as Record<string, unknown>)[field];
  return value === undefined || value === null ? null : formatValue(value);
}

/**
 * E3-9: overlays a still-open request's held critical values onto the
 * committed baseline, so re-validating a later submission diffs against
 * "what the organiser would see if they reopened the form" rather than
 * the committed value — resubmitting an already-held value is then a
 * true no-op (the field stays held, untouched) instead of looking like a
 * fresh change every time.
 */
export function withHeldValues(
  current: Partial<ValidatedEventRequest>,
  held: { field: string; newValue: string }[],
): Partial<ValidatedEventRequest> {
  const overlaid: Record<string, unknown> = { ...current };
  for (const { field, newValue } of held) {
    overlaid[field] = field === "expectedAttendance" ? Number(newValue) : newValue;
  }
  return overlaid as Partial<ValidatedEventRequest>;
}

export interface ChangeRequestFieldResult {
  field: string;
  oldValue: string | null;
  newValue: string;
  isCritical: boolean;
}

export interface ChangeRequestValidation {
  valid: boolean;
  fields: Record<string, string>;
  /** One entry per changed field in the request body, split critical/non-critical. */
  changes: ChangeRequestFieldResult[];
}

/**
 * E3-9: validates a partial change-request submission against the event's
 * current submitted_details. Only fields present in the body are checked —
 * unlike validateEventRequest (which validates a full new/draft request),
 * a change request may touch just one field. Reuses the same per-field
 * rules (no past date, valid time, end after start, positive attendance)
 * so a held or applied value can never violate E2-1's own constraints.
 */
export function validateChangeRequestFields(
  body: Record<string, unknown>,
  current: Partial<ValidatedEventRequest>,
): ChangeRequestValidation {
  const fields: Record<string, string> = {};
  const changes: ChangeRequestFieldResult[] = [];

  const submitted = EDITABLE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field));

  if (submitted.includes("proposedDate")) {
    const raw = body.proposedDate;
    if (isBlank(raw)) {
      fields.proposedDate = "This field is required.";
    } else {
      const parsed = new Date(String(raw));
      if (Number.isNaN(parsed.getTime())) {
        fields.proposedDate = "Enter a valid date.";
      } else if (String(raw) < todayIsoDate()) {
        fields.proposedDate = "The proposed date cannot be in the past.";
      }
    }
  }

  const effectiveStartTime = submitted.includes("startTime") ? body.startTime : current.startTime;
  const effectiveEndTime = submitted.includes("endTime") ? body.endTime : current.endTime;

  if (submitted.includes("startTime")) {
    if (isBlank(body.startTime)) fields.startTime = "This field is required.";
    else if (!TIME_PATTERN.test(String(body.startTime))) fields.startTime = "Enter a valid time.";
  }
  if (submitted.includes("endTime")) {
    if (isBlank(body.endTime)) fields.endTime = "This field is required.";
    else if (!TIME_PATTERN.test(String(body.endTime))) fields.endTime = "Enter a valid time.";
  }
  if (
    !fields.startTime &&
    !fields.endTime &&
    (submitted.includes("startTime") || submitted.includes("endTime")) &&
    effectiveStartTime &&
    effectiveEndTime
  ) {
    const toMinutes = (time: string) => {
      const [h, m] = time.split(":").map(Number);
      return h * 60 + m;
    };
    if (toMinutes(String(effectiveEndTime)) <= toMinutes(String(effectiveStartTime))) {
      fields.endTime = "End time must be after the start time.";
    }
  }

  if (submitted.includes("expectedAttendance")) {
    if (isBlank(body.expectedAttendance)) {
      fields.expectedAttendance = "This field is required.";
    } else {
      const numericValue = Number(body.expectedAttendance);
      if (!Number.isFinite(numericValue)) fields.expectedAttendance = "Enter a valid number.";
      else if (numericValue <= 0) fields.expectedAttendance = "Expected attendance must be greater than zero.";
    }
  }

  for (const field of ["name", "purpose", "description", "venue", "accessibility", "equipment", "technicalSupport"] as const) {
    if (submitted.includes(field) && isBlank(body[field])) {
      fields[field] = "This field is required.";
    }
  }

  if (Object.keys(fields).length > 0) {
    return { valid: false, fields, changes: [] };
  }

  for (const field of submitted) {
    const oldValue = (current as Record<string, unknown>)[field];
    const rawNew = body[field];
    const newValue = field === "registrationNeeded" ? rawNew === true || rawNew === "true" : String(rawNew).trim();

    // registrationNeeded's newValue is a boolean, comparable to oldValue
    // directly; every other field's newValue is a string, but oldValue
    // comes straight off `current` typed (expectedAttendance is a number)
    // — compare by string so resubmitting the same number isn't
    // mistaken for a change.
    const noChange =
      field === "registrationNeeded" ? oldValue === newValue : oldValue !== undefined && oldValue !== null && String(oldValue) === newValue;
    if (noChange) continue;

    changes.push({
      field,
      oldValue: oldValue === undefined || oldValue === null ? null : formatValue(oldValue),
      newValue: formatValue(newValue),
      isCritical: isCriticalField(field),
    });
  }

  return { valid: true, fields: {}, changes };
}
