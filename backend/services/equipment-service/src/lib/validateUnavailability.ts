// E5-5: validation for POST /api/equipment-units/:id/unavailability — a reason,
// a start date, an optional end date (none = until the unit is marked usable
// again) and an optional note.

import { UNAVAILABILITY_REASONS, type UnavailabilityReason } from "./unitUnavailability.js";

export interface UnavailabilityInput {
  reason: UnavailabilityReason;
  startDate: string;
  endDate: string | null;
  note: string | null;
}

export interface UnavailabilityValidation {
  valid: boolean;
  fields: Record<string, string>;
  value?: UnavailabilityInput;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_NOTE_LENGTH = 500;

/** A real calendar date in YYYY-MM-DD form (2026-02-30 is not). */
export function isRealDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validateUnavailability(input: unknown): UnavailabilityValidation {
  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!(UNAVAILABILITY_REASONS as readonly string[]).includes(reason)) {
    fields.reason = `Choose one of: ${UNAVAILABILITY_REASONS.join(", ")}.`;
  }

  const startDate = typeof body.startDate === "string" ? body.startDate.trim() : "";
  if (startDate === "") fields.startDate = "Start date is required.";
  else if (!isRealDate(startDate)) fields.startDate = "Enter a valid date.";

  const rawEnd = typeof body.endDate === "string" ? body.endDate.trim() : "";
  let endDate: string | null = null;
  if (body.endDate !== undefined && body.endDate !== null && rawEnd !== "") {
    if (!isRealDate(rawEnd)) fields.endDate = "Enter a valid date.";
    else if (!fields.startDate && rawEnd < startDate) fields.endDate = "End date can't be before the start date.";
    else endDate = rawEnd;
  }

  const rawNote = typeof body.note === "string" ? body.note.trim() : "";
  if (rawNote.length > MAX_NOTE_LENGTH) fields.note = `Use at most ${MAX_NOTE_LENGTH} characters.`;

  if (Object.keys(fields).length > 0) return { valid: false, fields };
  return {
    valid: true,
    fields: {},
    value: { reason: reason as UnavailabilityReason, startDate, endDate, note: rawNote === "" ? null : rawNote },
  };
}
