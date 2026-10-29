import { Router } from "express";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { EVENT_STATUS } from "../lib/eventStatus.js";
import { isPositiveInteger } from "../lib/validation.js";
import {
  ATTENDEE_INFO_FIELDS,
  attendeeAccessibility,
  attendeeOrganiserName,
  registrationInfo,
} from "./events.js";
import { clock } from "../lib/clock.js";

/**
 * Guests browsing the public landing pages: the events attendees can already
 * see (Confirmed, registration opened — the same `listed` rule as
 * GET /open-for-registration), with no login. Registering still needs an
 * attendee account; this only lets someone look first.
 *
 * Same whitelist as the attendee routes, minus capacity: a place count would
 * need registration-service's registered count, which is not public.
 */
export const publicEventsRouter = Router();

const EVENT_COLUMNS = "id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)";

interface PublicEventRow {
  id: number;
  status: string;
  submitted_details: Record<string, unknown> | null;
  registration_open_date: unknown;
  registration_override: unknown;
  organiser: unknown;
}

/** The listed event as guests see it, or null when it isn't listed. */
function toPublicEvent(row: PublicEventRow, now: Date) {
  const details = (row.submitted_details ?? {}) as Record<string, unknown>;
  const registration = registrationInfo(row, details, now);
  if (!registration.listed) return null;

  const event: Record<string, unknown> = {
    id: row.id,
    registrationState: registration.registrationState,
    open: registration.open,
    accessibility: attendeeAccessibility(details.accessibility),
    organiserName: attendeeOrganiserName(row.organiser),
  };
  for (const field of ATTENDEE_INFO_FIELDS) event[field] = details[field] ?? null;
  return event;
}

// Stryker disable next-line StringLiteral: equivalent - the router treats the path "" exactly like "/"
publicEventsRouter.get("/", async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from("events")
    .select(EVENT_COLUMNS)
    .eq("status", EVENT_STATUS.Confirmed);
  if (error) {
    res.status(500).json({ error: "Failed to load events" });
    return;
  }

  const now = clock.now();
  const events = ((data ?? []) as PublicEventRow[]).flatMap((row) => toPublicEvent(row, now) ?? []);
  res.json({ events });
});

/** One listed event. Anything else — unlisted, not Confirmed, missing — is a plain 404. */
publicEventsRouter.get("/:id", async (req, res) => {
  if (!isPositiveInteger(req.params.id)) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("events")
    .select(EVENT_COLUMNS)
    .eq("id", Number(req.params.id))
    .eq("status", EVENT_STATUS.Confirmed)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: "Failed to load the event" });
    return;
  }

  const event = data ? toPublicEvent(data as PublicEventRow, clock.now()) : null;
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  res.json({ event });
});
