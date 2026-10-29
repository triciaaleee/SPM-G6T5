// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
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
  if (stryMutAct_9fa48("724")) {
    {}
  } else {
    stryCov_9fa48("724");
    return (stryMutAct_9fa48("727") ? typeof value === "string" || value.trim() : stryMutAct_9fa48("726") ? false : stryMutAct_9fa48("725") ? true : (stryCov_9fa48("725", "726", "727"), (stryMutAct_9fa48("729") ? typeof value !== "string" : stryMutAct_9fa48("728") ? true : (stryCov_9fa48("728", "729"), typeof value === (stryMutAct_9fa48("730") ? "" : (stryCov_9fa48("730"), "string")))) && (stryMutAct_9fa48("731") ? value : (stryCov_9fa48("731"), value.trim())))) ? value : null;
  }
}
export function scheduleOf(details: Record<string, unknown> | null | undefined): EventSchedule {
  if (stryMutAct_9fa48("732")) {
    {}
  } else {
    stryCov_9fa48("732");
    return stryMutAct_9fa48("733") ? {} : (stryCov_9fa48("733"), {
      proposedDate: scheduleValue(stryMutAct_9fa48("734") ? details.proposedDate : (stryCov_9fa48("734"), details?.proposedDate)),
      startTime: scheduleValue(stryMutAct_9fa48("735") ? details.startTime : (stryCov_9fa48("735"), details?.startTime)),
      endTime: scheduleValue(stryMutAct_9fa48("736") ? details.endTime : (stryCov_9fa48("736"), details?.endTime))
    });
  }
}

/** True when the date, start time or end time differs. Empty and missing count as the same. */
export function scheduleChanged(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined): boolean {
  if (stryMutAct_9fa48("737")) {
    {}
  } else {
    stryCov_9fa48("737");
    const a = scheduleOf(before);
    const b = scheduleOf(after);
    return stryMutAct_9fa48("738") ? SCHEDULE_FIELDS.every(field => a[field] !== b[field]) : (stryCov_9fa48("738"), SCHEDULE_FIELDS.some(stryMutAct_9fa48("739") ? () => undefined : (stryCov_9fa48("739"), field => stryMutAct_9fa48("742") ? a[field] === b[field] : stryMutAct_9fa48("741") ? false : stryMutAct_9fa48("740") ? true : (stryCov_9fa48("740", "741", "742"), a[field] !== b[field]))));
  }
}

/** The expected attendance as a whole number, or null when it is missing or not a number. */
export function attendanceOf(details: Record<string, unknown> | null | undefined): number | null {
  if (stryMutAct_9fa48("743")) {
    {}
  } else {
    stryCov_9fa48("743");
    const raw = stryMutAct_9fa48("744") ? details.expectedAttendance : (stryCov_9fa48("744"), details?.expectedAttendance);
    const value = (stryMutAct_9fa48("747") ? typeof raw === "string" || raw.trim() !== "" : stryMutAct_9fa48("746") ? false : stryMutAct_9fa48("745") ? true : (stryCov_9fa48("745", "746", "747"), (stryMutAct_9fa48("749") ? typeof raw !== "string" : stryMutAct_9fa48("748") ? true : (stryCov_9fa48("748", "749"), typeof raw === (stryMutAct_9fa48("750") ? "" : (stryCov_9fa48("750"), "string")))) && (stryMutAct_9fa48("752") ? raw.trim() === "" : stryMutAct_9fa48("751") ? true : (stryCov_9fa48("751", "752"), (stryMutAct_9fa48("753") ? raw : (stryCov_9fa48("753"), raw.trim())) !== (stryMutAct_9fa48("754") ? "Stryker was here!" : (stryCov_9fa48("754"), "")))))) ? Number(raw) : raw;
    // Number.isFinite is false for anything that is not a finite number (null, objects, booleans).
    return Number.isFinite(value) ? value as number : null;
  }
}

/** True when the expected attendance differs. A missing value and a different one are a change. */
export function attendanceChanged(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined): boolean {
  if (stryMutAct_9fa48("755")) {
    {}
  } else {
    stryCov_9fa48("755");
    return stryMutAct_9fa48("758") ? attendanceOf(before) === attendanceOf(after) : stryMutAct_9fa48("757") ? false : stryMutAct_9fa48("756") ? true : (stryCov_9fa48("756", "757", "758"), attendanceOf(before) !== attendanceOf(after));
  }
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
export async function announceReschedule(supabase: Supabase, event: {
  id: number;
  actorId: string;
  eventName: string;
  /** Who coordinates the event, so equipment-service can notify them without a lookup; null if unassigned. */
  coordinatorId: string | null;
  details: Record<string, unknown> | null | undefined;
}): Promise<boolean> {
  if (stryMutAct_9fa48("759")) {
    {}
  } else {
    stryCov_9fa48("759");
    try {
      if (stryMutAct_9fa48("760")) {
        {}
      } else {
        stryCov_9fa48("760");
        return await publishDurably(supabase, stryMutAct_9fa48("761") ? {} : (stryCov_9fa48("761"), {
          type: stryMutAct_9fa48("762") ? "" : (stryCov_9fa48("762"), "event.rescheduled"),
          eventId: event.id,
          actorId: event.actorId,
          recipients: stryMutAct_9fa48("763") ? {} : (stryCov_9fa48("763"), {
            userIds: stryMutAct_9fa48("764") ? ["Stryker was here"] : (stryCov_9fa48("764"), []),
            roles: stryMutAct_9fa48("765") ? ["Stryker was here"] : (stryCov_9fa48("765"), [])
          }),
          data: stryMutAct_9fa48("766") ? {} : (stryCov_9fa48("766"), {
            eventName: event.eventName,
            coordinatorId: event.coordinatorId,
            ...scheduleOf(event.details)
          })
        }));
      }
    } catch (err) {
      if (stryMutAct_9fa48("767")) {
        {}
      } else {
        stryCov_9fa48("767");
        console.error(stryMutAct_9fa48("769") ? `` : (stryCov_9fa48("769"), `events-service: could not announce the reschedule of event ${event.id}`), err);
        return stryMutAct_9fa48("770") ? true : (stryCov_9fa48("770"), false);
      }
    }
  }
}

/**
 * Tells venue-service the event's expected attendance changed
 * (`event.attendance_changed`), so it can flag a booking at a venue that is now too
 * small. Same handling as `announceReschedule`: through the outbox, best effort for
 * the caller (the edit is already saved), nobody notified directly.
 */
export async function announceAttendanceChange(supabase: Supabase, event: {
  id: number;
  actorId: string;
  eventName: string;
  coordinatorId: string | null;
  details: Record<string, unknown> | null | undefined;
}): Promise<boolean> {
  if (stryMutAct_9fa48("771")) {
    {}
  } else {
    stryCov_9fa48("771");
    try {
      if (stryMutAct_9fa48("772")) {
        {}
      } else {
        stryCov_9fa48("772");
        return await publishDurably(supabase, stryMutAct_9fa48("773") ? {} : (stryCov_9fa48("773"), {
          type: stryMutAct_9fa48("774") ? "" : (stryCov_9fa48("774"), "event.attendance_changed"),
          eventId: event.id,
          actorId: event.actorId,
          recipients: stryMutAct_9fa48("775") ? {} : (stryCov_9fa48("775"), {
            userIds: stryMutAct_9fa48("776") ? ["Stryker was here"] : (stryCov_9fa48("776"), []),
            roles: stryMutAct_9fa48("777") ? ["Stryker was here"] : (stryCov_9fa48("777"), [])
          }),
          data: stryMutAct_9fa48("778") ? {} : (stryCov_9fa48("778"), {
            eventName: event.eventName,
            coordinatorId: event.coordinatorId,
            expectedAttendance: attendanceOf(event.details)
          })
        }));
      }
    } catch (err) {
      if (stryMutAct_9fa48("779")) {
        {}
      } else {
        stryCov_9fa48("779");
        console.error(stryMutAct_9fa48("781") ? `` : (stryCov_9fa48("781"), `events-service: could not announce the attendance change of event ${event.id}`), err);
        return stryMutAct_9fa48("782") ? true : (stryCov_9fa48("782"), false);
      }
    }
  }
}