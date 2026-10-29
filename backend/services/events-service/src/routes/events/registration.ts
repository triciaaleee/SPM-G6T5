import { Router } from "express";
import type { AuthedRequest } from "../../middleware/auth.js";
import { isPositiveInteger } from "../../lib/validation.js";
import { EVENT_STATUS } from "../../lib/eventStatus.js";
import { eventStartsAt, hasEventStarted, localDateStart } from "../../lib/eventTiming.js";
import {
  getRegistrationState,
  isListed,
  REGISTRATION_CUTOFF_DAYS,
  REGISTRATION_DATE_EDITABLE_STATUSES,
  REGISTRATION_OVERRIDE,
  REGISTRATION_STATE,
} from "../../lib/registrationPeriod.js";
import type { RegistrationOverride } from "../../lib/registrationPeriod.js";
import { routeParam, recordAccessDenial, recordEventHistory, EVENT_COLUMNS, authorizeCoordinatorReview } from "./shared.js";
import { clock } from "../../lib/clock.js";

/**
 * Registration settings controller (E6): the assigned coordinator sets when
 * registration opens or forces it open or closed, and registration-service reads
 * what attendees may see. The attendee-view helpers are shared with
 * publicEvents.ts.
 */

export const registrationRouter = Router();

/**
 * E6: the only fields an Attendee may see about an event — what is safe to
 * show someone who is not part of the planning. Built as a whitelist, never
 * by filtering a fuller object, so a field added to submitted_details later
 * stays private until it is listed here. No coordinator, purpose, equipment,
 * review outcome, history or clarifications, and of the organiser only their
 * display name (never their id, email or contact details). The accessibility
 * note and the capacity (expected attendance) are added explicitly by the
 * routes below.
 */
export const ATTENDEE_INFO_FIELDS = ["name", "description", "proposedDate", "startTime", "endTime"] as const;

/** Whole-field answers that mean "nothing to note" (same list venue-service uses for requirements). */
const NO_ACCESSIBILITY_INFO_PATTERN =
  /^(n\/?a|nil|none|no|nope|-+|not applicable|no preference|no requirements?|not required|not needed)\.?$/i;

/**
 * The organiser's accessibility note, as written, for attendees. Blank or a
 * "NA"/"None" style answer is no note at all, so the card shows nothing
 * rather than "None".
 */
export function attendeeAccessibility(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" || NO_ACCESSIBILITY_INFO_PATTERN.test(text) ? null : text;
}

/**
 * How many attendees may register, shown to attendees as slots left. The
 * single place capacity is decided: today it is the organiser's expected
 * attendance; a dedicated registration limit would be read here instead.
 * Null when there is no usable number (older events), meaning no cap.
 */
export function attendeeCapacity(details: Record<string, unknown>): number | null {
  const value = Number(details.expectedAttendance);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The organiser's display name for attendees, from the `organiser:organiser_id(name)`
 * embed. Name only: nothing else about the organiser is read or returned.
 */
export function attendeeOrganiserName(organiser: unknown): string | null {
  const record = (Array.isArray(organiser) ? organiser[0] : organiser) as { name?: unknown } | null | undefined;
  const name = record?.name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : null;
}

const MAX_ATTENDEE_INFO_IDS = 100;

interface RegistrationRowFields {
  status: string;
  registration_open_date?: unknown;
  registration_override?: unknown;
}

/**
 * The registration period as attendees need it: the state (NOT_OPEN, OPEN or
 * CLOSED — registration-service turns OPEN into FULL when no places are left,
 * since it owns the count), whether the event is listed, and `open` (state is
 * OPEN). Lives here, with the event data, so registration-service doesn't
 * re-derive it. Times are Singapore time (lib/eventTiming.ts); the rules are
 * in lib/registrationPeriod.ts.
 */
export function registrationInfo(row: RegistrationRowFields, details: Record<string, unknown>, now: Date = clock.now()) {
  const inputs = {
    status: row.status,
    details,
    openDate: row.registration_open_date,
    override: row.registration_override,
  };
  const registrationState = getRegistrationState(inputs, now);
  return {
    registrationState,
    listed: isListed(inputs, now),
    open: registrationState === REGISTRATION_STATE.Open,
  };
}

/**
 * E6: attendee-facing info for a batch of events, called by
 * registration-service with the caller's own token. Attendees only — other
 * roles have fuller routes. Declared before GET /:id so "attendee-info"
 * isn't read as an event id. Drafts are never returned.
 *
 * An event is returned whether or not it is open: registration-service
 * decides whether *this* attendee may see it (registered, or open), using
 * the `open` flag computed here. Ids that don't exist are simply absent.
 */
registrationRouter.get("/attendee-info", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const rawIds = typeof req.query.ids === "string" ? req.query.ids : "";

  if (user.role !== "attendee") {
    await recordAccessDenial(supabase, user.id, rawIds, "attendee_info_role_not_allowed");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const idStrings = rawIds.split(",").map((id) => id.trim());
  // An absent or empty list splits to [""], which is not a positive integer, so it is refused here too.
  if (!idStrings.every(isPositiveInteger) || idStrings.length > MAX_ATTENDEE_INFO_IDS) {
    res.status(400).json({ error: `ids must be 1–${MAX_ATTENDEE_INFO_IDS} comma-separated event ids` });
    return;
  }
  const ids = [...new Set(idStrings.map(Number))];

  const { data, error } = await supabase
    .from("events")
    .select("id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)")
    .in("id", ids)
    .neq("status", "Draft");

  if (error) {
    res.status(500).json({ error: "Failed to load events" });
    return;
  }

  const events = (data ?? []).map((row) => {
    const details = (row.submitted_details ?? {}) as Record<string, unknown>;
    const info: Record<string, unknown> = {
      id: row.id,
      registrationNeeded: details.registrationNeeded === true,
      ...registrationInfo(row, details),
      accessibility: attendeeAccessibility(details.accessibility),
      capacity: attendeeCapacity(details),
      organiserName: attendeeOrganiserName(row.organiser),
      // E6-4: an attendee may withdraw until the event starts.
      hasStarted: hasEventStarted(details),
    };
    for (const field of ATTENDEE_INFO_FIELDS) info[field] = details[field] ?? null;
    return info;
  });

  res.json({ events });
});

/**
 * E6: Confirmed events currently open for registration, so an attendee can
 * find something to register for. Same whitelist as GET /attendee-info.
 * Declared before GET /:id.
 */
registrationRouter.get("/open-for-registration", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  if (user.role !== "attendee") {
    await recordAccessDenial(supabase, user.id, "", "open_for_registration_role_not_allowed");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .select("id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)")
    .eq("status", "Confirmed");

  if (error) {
    res.status(500).json({ error: "Failed to load events" });
    return;
  }

  // Stryker disable next-line ArrayDeclaration: equivalent - a placeholder row has no status, so it is never listed
  const events = (data ?? [])
    .map((row) => ({ row, details: (row.submitted_details ?? {}) as Record<string, unknown> }))
    .filter(({ row, details }) => registrationInfo(row, details).listed)
    .map(({ row, details }) => {
      const info: Record<string, unknown> = {
        id: row.id,
        registrationNeeded: true,
        ...registrationInfo(row, details),
        accessibility: attendeeAccessibility(details.accessibility),
        capacity: attendeeCapacity(details),
        organiserName: attendeeOrganiserName(row.organiser),
      };
      for (const field of ATTENDEE_INFO_FIELDS) info[field] = details[field] ?? null;
      return info;
    });

  res.json({ events });
});

/**
 * Registration period (coordinator). Only the assigned coordinator, via
 * authorizeCoordinatorReview. Writes the stored intent (open date, manual
 * open/close); whether registration is open right now is derived on read
 * (lib/registrationPeriod.ts), so nothing here opens or closes anything on a
 * timer. Each change goes into the event history.
 */
async function loadRegistrationRow(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  eventId: number,
): Promise<{
  submitted_details: Record<string, unknown> | null;
  registration_open_date: string | null;
  registration_override: string | null;
} | null> {
  const { data } = await supabase
    .from("events")
    .select("submitted_details, registration_open_date, registration_override")
    .eq("id", eventId)
    .maybeSingle();
  return data ?? null;
}

registrationRouter.put("/:id/registration", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
  const event = await authorizeCoordinatorReview(req, res, eventId);
  if (!event) return;

  if (!REGISTRATION_DATE_EDITABLE_STATUSES.includes(event.status)) {
    res.status(409).json({ error: "The registration open date can only be set once the event is in Planning, and before it ends" });
    return;
  }

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const row = await loadRegistrationRow(supabase, event.id);
  if (!row) {
    res.status(500).json({ error: "Failed to load event" });
    return;
  }
  const details = row.submitted_details ?? {};
  if (details.registrationNeeded !== true) {
    res.status(409).json({ error: "This event doesn't need registration" });
    return;
  }

  const openDate = (req.body ?? {}).openDate;
  if (localDateStart(openDate) === null) {
    res.status(400).json({ error: "openDate must be a date in YYYY-MM-DD format" });
    return;
  }
  const startsAt = eventStartsAt(details);
  if (startsAt !== null) {
    const cutoff = startsAt.getTime() - REGISTRATION_CUTOFF_DAYS * 24 * 60 * 60 * 1000;
    if ((localDateStart(openDate) as Date).getTime() >= cutoff) {
      res.status(400).json({
        error: `Registration closes ${REGISTRATION_CUTOFF_DAYS} days before the event, so the open date must be earlier than that`,
      });
      return;
    }
  }

  const { data, error } = await supabase
    .from("events")
    .update({ registration_open_date: openDate })
    .eq("id", event.id)
    .eq("coordinator_id", user.id)
    .in("status", REGISTRATION_DATE_EDITABLE_STATUSES)
    .select(EVENT_COLUMNS)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: "Failed to save the registration open date" });
    return;
  }
  if (!data) {
    res.status(409).json({ error: "This event changed or is no longer assigned to you" });
    return;
  }

  await recordEventHistory(
    supabase,
    event.id,
    [{ field: "Registration open date", oldValue: row.registration_open_date, newValue: openDate as string }],
    user.id,
  );

  res.json({ event: data });
});

/** open / close / auto: the manual override on registration (Confirmed events only). */
function registrationOverrideRoute(action: string, override: RegistrationOverride) {
  registrationRouter.post(`/:id/registration/${action}`, async (req: AuthedRequest, res) => {
    const eventId = routeParam(req.params.id);
    const event = await authorizeCoordinatorReview(req, res, eventId);
    if (!event) return;

    if (event.status !== EVENT_STATUS.Confirmed) {
      res.status(409).json({ error: "Registration can only be opened or closed for a Confirmed event" });
      return;
    }

    const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
    const row = await loadRegistrationRow(supabase, event.id);
    if (!row) {
      res.status(500).json({ error: "Failed to load event" });
      return;
    }
    if ((row.submitted_details ?? {}).registrationNeeded !== true) {
      res.status(409).json({ error: "This event doesn't need registration" });
      return;
    }
    // The guard above already refused a missing submitted_details.
    const startsAt = eventStartsAt(row.submitted_details!);
    if (override === REGISTRATION_OVERRIDE.ForceOpen && startsAt !== null && startsAt.getTime() <= clock.now().getTime()) {
      res.status(409).json({ error: "This event has already started, so registration can't be opened" });
      return;
    }

    const { data, error } = await supabase
      .from("events")
      .update({ registration_override: override })
      .eq("id", event.id)
      .eq("status", EVENT_STATUS.Confirmed)
      .eq("coordinator_id", user.id)
      .select(EVENT_COLUMNS)
      .maybeSingle();
    if (error) {
      res.status(500).json({ error: "Failed to update registration" });
      return;
    }
    if (!data) {
      res.status(409).json({ error: "This event is no longer Confirmed or no longer assigned to you" });
      return;
    }

    await recordEventHistory(
      supabase,
      event.id,
      [{ field: "Registration override", oldValue: row.registration_override ?? REGISTRATION_OVERRIDE.None, newValue: override }],
      user.id,
    );

    res.json({ event: data });
  });
}

registrationOverrideRoute("open", REGISTRATION_OVERRIDE.ForceOpen);
registrationOverrideRoute("close", REGISTRATION_OVERRIDE.ForceClosed);
registrationOverrideRoute("auto", REGISTRATION_OVERRIDE.None);
