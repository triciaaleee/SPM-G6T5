import type { supabaseAdmin } from "./supabaseAdmin.js";
import { publishDurably } from "./outbox.js";

type Supabase = typeof supabaseAdmin;

/** The submitted_details fields that decide when an event happens. */
export const SCHEDULE_FIELDS = ["proposedDate", "startTime", "endTime"] as const;

export interface EventSchedule {
  proposedDate: string | null;
  startTime: string | null;
  endTime: string | null;
}

function scheduleValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function scheduleOf(details: Record<string, unknown> | null | undefined): EventSchedule {
  return {
    proposedDate: scheduleValue(details?.proposedDate),
    startTime: scheduleValue(details?.startTime),
    endTime: scheduleValue(details?.endTime),
  };
}

/** True when the date, start time or end time differs. Empty and missing count as the same. */
export function scheduleChanged(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): boolean {
  const a = scheduleOf(before);
  const b = scheduleOf(after);
  return SCHEDULE_FIELDS.some((field) => a[field] !== b[field]);
}

/** The expected attendance as a whole number, or null when it is missing or not a number. */
export function attendanceOf(details: Record<string, unknown> | null | undefined): number | null {
  const raw = details?.expectedAttendance;
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** True when the expected attendance differs. A missing value and a different one are a change. */
export function attendanceChanged(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): boolean {
  return attendanceOf(before) !== attendanceOf(after);
}

/**
 * Tells the other services an event now happens at a different time
 * (`event.rescheduled`, RabbitMQ.md). equipment-service moves its stored
 * booking windows to match. Goes through the outbox like `event.cancelled`,
 * since another service must act on it, but is best-effort for the caller:
 * the edit has already been saved, and equipment-service also refreshes a
 * stale window the next time it claims units, so a lost message is not fatal.
 * Nobody is notified (no recipients).
 */
export async function announceReschedule(
  supabase: Supabase,
  event: {
    id: number;
    actorId: string;
    eventName: string;
    /** Who coordinates the event, so equipment-service can notify them without a lookup; null if unassigned. */
    coordinatorId: string | null;
    details: Record<string, unknown> | null | undefined;
  },
): Promise<boolean> {
  try {
    return await publishDurably(supabase, {
      type: "event.rescheduled",
      eventId: event.id,
      actorId: event.actorId,
      recipients: { userIds: [], roles: [] },
      data: { eventName: event.eventName, coordinatorId: event.coordinatorId, ...scheduleOf(event.details) },
    });
  } catch (err) {
    console.error(`events-service: could not announce the reschedule of event ${event.id}`, err);
    return false;
  }
}

/**
 * Tells venue-service the event's expected attendance changed
 * (`event.attendance_changed`), so it can flag a booking at a venue that is now too
 * small. Same handling as `announceReschedule`: through the outbox, best effort for
 * the caller (the edit is already saved), nobody notified directly.
 */
export async function announceAttendanceChange(
  supabase: Supabase,
  event: {
    id: number;
    actorId: string;
    eventName: string;
    coordinatorId: string | null;
    details: Record<string, unknown> | null | undefined;
  },
): Promise<boolean> {
  try {
    return await publishDurably(supabase, {
      type: "event.attendance_changed",
      eventId: event.id,
      actorId: event.actorId,
      recipients: { userIds: [], roles: [] },
      data: { eventName: event.eventName, coordinatorId: event.coordinatorId, expectedAttendance: attendanceOf(event.details) },
    });
  } catch (err) {
    console.error(`events-service: could not announce the attendance change of event ${event.id}`, err);
    return false;
  }
}
