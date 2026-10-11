import { Router } from "express";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { REGISTRATION_STATUS } from "../lib/registrationStatus.js";
import type { RegistrationStatus } from "../lib/registrationStatus.js";
import { canViewEvent, fetchAttendeeEvents, fetchOpenEvents } from "../lib/eventsClient.js";
import { fetchVenueNames } from "../lib/venuesClient.js";
import { fetchUserNames } from "../lib/usersClient.js";

/**
 * E6: attendee registration. This service owns the `registrations` table and
 * nothing else — event details, venue names and user names all come from the
 * services that own them, over REST, with the caller's own token.
 *
 * What an attendee may see is decided by the whitelisted shapes those
 * services return (events-service `attendee-info`, venue-service
 * `attendee-info`), never by filtering a fuller record here. The one route
 * that exposes other people (the roster) is closed to attendees.
 */
export const registrationsRouter = Router();

registrationsRouter.use(requireAuth);

const REGISTRATION_COLUMNS = "registration_id, event_id, user_id, status, created_at, additional_info";

/** Postgres unique_violation — a second registration racing past the lookup. */
const PG_UNIQUE_VIOLATION = "23505";

/** additional_info is free-form, so cap it rather than let one row grow without bound. */
const MAX_ADDITIONAL_INFO_CHARS = 5000;

interface RegistrationRow {
  registration_id: number;
  event_id: number;
  user_id: string;
  status: RegistrationStatus;
  created_at: string;
  additional_info: Record<string, unknown> | null;
}

function toRegistration(row: RegistrationRow) {
  return {
    registrationId: row.registration_id,
    eventId: row.event_id,
    userId: row.user_id,
    status: row.status,
    createdAt: row.created_at,
    additionalInfo: row.additional_info,
  };
}

/** True when the response was already sent (not an attendee). */
function requireAttendee(req: AuthedRequest, res: Response): boolean {
  if (req.user?.role !== "attendee") {
    res.status(403).json({ error: "Access denied" });
    return false;
  }
  return true;
}

function parseEventId(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && /^[1-9]\d*$/.test(text) ? Number(text) : null;
}

/** undefined/null → no info; a plain object within the size cap → itself; anything else → invalid. */
function parseAdditionalInfo(raw: unknown): { ok: true; value: Record<string, unknown> | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  if (JSON.stringify(raw).length > MAX_ADDITIONAL_INFO_CHARS) return { ok: false };
  return { ok: true, value: raw as Record<string, unknown> };
}

/**
 * Events open for registration, each with the caller's own registration
 * status (null if they have none). Declared before the `/event/:eventId`
 * routes only for readability; the paths don't overlap.
 */
registrationsRouter.get("/open-events", async (req: AuthedRequest, res) => {
  if (!requireAttendee(req, res)) return;
  const { supabase, user } = req;

  const open = await fetchOpenEvents(req.headers.authorization!);
  if (open.status === "error") {
    res.status(502).json({ error: "Failed to load events" });
    return;
  }

  const eventIds = open.events.map((event) => event.id);
  const statusByEvent = new Map<number, RegistrationStatus>();
  if (eventIds.length > 0) {
    const { data, error } = await supabase!
      .from("registrations")
      .select("event_id, status")
      .eq("user_id", user!.id)
      .in("event_id", eventIds);
    if (error) {
      res.status(500).json({ error: "Failed to load registrations" });
      return;
    }
    for (const row of (data ?? []) as { event_id: number; status: RegistrationStatus }[]) {
      statusByEvent.set(row.event_id, row.status);
    }
  }

  res.json({
    events: open.events.map((event) => ({ ...event, registrationStatus: statusByEvent.get(event.id) ?? null })),
  });
});

/**
 * An attendee's own registrations (Registered and Withdrawn), newest first,
 * each with the event's name, description, schedule, venue names and
 * accessibility note. The path id must be the caller's
 * own: an attendee can never list someone else's registrations.
 */
registrationsRouter.get("/user/:userId", async (req: AuthedRequest, res) => {
  if (!requireAttendee(req, res)) return;
  const { supabase, user } = req;

  const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  if (userId !== user!.id) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { data, error } = await supabase!
    .from("registrations")
    .select(REGISTRATION_COLUMNS)
    .eq("user_id", user!.id)
    .order("created_at", { ascending: false });
  if (error) {
    res.status(500).json({ error: "Failed to load registrations" });
    return;
  }

  const rows = (data ?? []) as RegistrationRow[];
  const events = await fetchAttendeeEvents(
    [...new Set(rows.map((row) => row.event_id))],
    req.headers.authorization!,
  );
  if (events.status === "error") {
    res.status(502).json({ error: "Failed to load events" });
    return;
  }
  const eventById = new Map(events.events.map((event) => [event.id, event]));

  const venues = await fetchVenueNames(
    [...new Set(rows.map((row) => row.event_id))],
    req.headers.authorization!,
  );
  if (venues.status === "error") {
    res.status(502).json({ error: "Failed to load the events' venues" });
    return;
  }

  res.json({
    registrations: rows.map((row) => {
      const event = eventById.get(row.event_id);
      return {
        ...toRegistration(row),
        event: event
          ? {
              name: event.name,
              description: event.description,
              proposedDate: event.proposedDate,
              startTime: event.startTime,
              endTime: event.endTime,
              venues: venues.venuesByEvent.get(row.event_id) ?? [],
              accessibility: event.accessibility,
            }
          : null,
      };
    }),
  });
});

/**
 * The roster for one event. The only route that shows other attendees, so
 * it is closed to attendees outright; organisers and coordinators are
 * admitted by events-service's own rule (the owning organiser, or any
 * coordinator) rather than a second copy of it here.
 */
registrationsRouter.get("/event/:eventId", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;

  const eventId = parseEventId(req.params.eventId);
  if (eventId === null) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }

  if (user!.role !== "organiser" && user!.role !== "coordinator") {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const authorization = req.headers.authorization!;
  const access = await canViewEvent(eventId, authorization);
  if (access.status === "denied") {
    res.status(403).json({ error: "Access denied" });
    return;
  }
  if (access.status === "error") {
    res.status(502).json({ error: "Failed to load the event" });
    return;
  }

  const { data, error } = await supabase!
    .from("registrations")
    .select(REGISTRATION_COLUMNS)
    .eq("event_id", eventId)
    .order("created_at");
  if (error) {
    res.status(500).json({ error: "Failed to load registrations" });
    return;
  }

  const rows = (data ?? []) as RegistrationRow[];
  const names = await fetchUserNames([...new Set(rows.map((row) => row.user_id))], authorization);

  res.json({
    registrations: rows.map((row) => ({ ...toRegistration(row), name: names.get(row.user_id) ?? null })),
  });
});

/**
 * Register for an event. The event must be open. Registering again after a
 * withdrawal reuses the same row (one row per attendee per event), keeping
 * its original created_at.
 */
registrationsRouter.post("/", async (req: AuthedRequest, res) => {
  if (!requireAttendee(req, res)) return;
  const { supabase, user } = req;

  const eventId = parseEventId(req.body?.eventId);
  if (eventId === null) {
    res.status(400).json({ error: "eventId must be a positive integer", field: "eventId" });
    return;
  }

  const info = parseAdditionalInfo(req.body?.additionalInfo);
  if (!info.ok) {
    res.status(400).json({
      error: `additionalInfo must be an object under ${MAX_ADDITIONAL_INFO_CHARS} characters`,
      field: "additionalInfo",
    });
    return;
  }

  const events = await fetchAttendeeEvents([eventId], req.headers.authorization!);
  if (events.status === "error") {
    res.status(502).json({ error: "Failed to load the event" });
    return;
  }
  const event = events.events.find((e) => e.id === eventId);
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  if (!event.open) {
    res.status(409).json({ error: "This event is not open for registration", code: "not_open" });
    return;
  }

  const { data: existing, error: lookupError } = await supabase!
    .from("registrations")
    .select(REGISTRATION_COLUMNS)
    .eq("event_id", eventId)
    .eq("user_id", user!.id)
    .maybeSingle();
  if (lookupError) {
    res.status(500).json({ error: "Failed to register" });
    return;
  }

  const alreadyRegistered = () =>
    res.status(409).json({ error: "You are already registered for this event", code: "already_registered" });

  if (existing) {
    if ((existing as RegistrationRow).status === REGISTRATION_STATUS.registered) {
      alreadyRegistered();
      return;
    }

    // Re-registering after a withdrawal: same row, back to Registered. New
    // additional_info replaces the old; leaving it out keeps what was there.
    const { data: updated, error: updateError } = await supabase!
      .from("registrations")
      .update({
        status: REGISTRATION_STATUS.registered,
        ...(req.body?.additionalInfo !== undefined ? { additional_info: info.value } : {}),
      })
      .eq("registration_id", (existing as RegistrationRow).registration_id)
      .select(REGISTRATION_COLUMNS)
      .single();
    if (updateError || !updated) {
      res.status(500).json({ error: "Failed to register" });
      return;
    }
    res.json({ registration: toRegistration(updated as RegistrationRow) });
    return;
  }

  const { data: created, error: insertError } = await supabase!
    .from("registrations")
    .insert({
      event_id: eventId,
      user_id: user!.id,
      status: REGISTRATION_STATUS.registered,
      additional_info: info.value,
    })
    .select(REGISTRATION_COLUMNS)
    .single();

  if (insertError?.code === PG_UNIQUE_VIOLATION) {
    // Two requests for the same event both passed the lookup; the unique
    // constraint caught the second.
    alreadyRegistered();
    return;
  }
  if (insertError || !created) {
    res.status(500).json({ error: "Failed to register" });
    return;
  }

  res.status(201).json({ registration: toRegistration(created as RegistrationRow) });
});

/** Give up a place. The row is kept as Withdrawn rather than deleted. */
registrationsRouter.patch("/event/:eventId/withdraw", async (req: AuthedRequest, res) => {
  if (!requireAttendee(req, res)) return;
  const { supabase, user } = req;

  const eventId = parseEventId(req.params.eventId);
  if (eventId === null) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }

  const { data: existing, error: lookupError } = await supabase!
    .from("registrations")
    .select(REGISTRATION_COLUMNS)
    .eq("event_id", eventId)
    .eq("user_id", user!.id)
    .maybeSingle();
  if (lookupError) {
    res.status(500).json({ error: "Failed to withdraw" });
    return;
  }
  if (!existing) {
    res.status(404).json({ error: "You are not registered for this event" });
    return;
  }
  if ((existing as RegistrationRow).status === REGISTRATION_STATUS.withdrawn) {
    res.status(409).json({ error: "You have already withdrawn from this event", code: "already_withdrawn" });
    return;
  }

  const { data: updated, error: updateError } = await supabase!
    .from("registrations")
    .update({ status: REGISTRATION_STATUS.withdrawn })
    .eq("registration_id", (existing as RegistrationRow).registration_id)
    .select(REGISTRATION_COLUMNS)
    .single();
  if (updateError || !updated) {
    res.status(500).json({ error: "Failed to withdraw" });
    return;
  }

  res.json({ registration: toRegistration(updated as RegistrationRow) });
});

/**
 * What an attendee sees when they open an event: name, description, date,
 * time, venue(s) and their own registration status — and nothing else.
 *
 * Access: allowed if they hold a Registered place, or if the event is open
 * for registration (so they can look before signing up). Otherwise denied
 * — an event that isn't open, that they aren't registered for, is
 * indistinguishable from one that doesn't exist.
 */
registrationsRouter.get("/event/:eventId/view", async (req: AuthedRequest, res) => {
  if (!requireAttendee(req, res)) return;
  const { supabase, user } = req;

  const eventId = parseEventId(req.params.eventId);
  if (eventId === null) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }

  const { data: registration, error: lookupError } = await supabase!
    .from("registrations")
    .select("status")
    .eq("event_id", eventId)
    .eq("user_id", user!.id)
    .maybeSingle();
  if (lookupError) {
    res.status(500).json({ error: "Failed to load the event" });
    return;
  }
  const registrationStatus = ((registration as { status: RegistrationStatus } | null)?.status ??
    null) as RegistrationStatus | null;

  const authorization = req.headers.authorization!;
  const events = await fetchAttendeeEvents([eventId], authorization);
  if (events.status === "error") {
    res.status(502).json({ error: "Failed to load the event" });
    return;
  }
  const event = events.events.find((e) => e.id === eventId);

  const hasPlace = registrationStatus === REGISTRATION_STATUS.registered;
  if (!event || (!hasPlace && !event.open)) {
    console.warn(`Attendee ${user!.id} denied access to event ${eventId} (not registered, not open)`);
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const venues = await fetchVenueNames([eventId], authorization);
  if (venues.status === "error") {
    res.status(502).json({ error: "Failed to load the event's venue" });
    return;
  }

  res.json({
    event: {
      id: event.id,
      name: event.name,
      description: event.description,
      proposedDate: event.proposedDate,
      startTime: event.startTime,
      endTime: event.endTime,
      venues: venues.venuesByEvent.get(eventId) ?? [],
      accessibility: event.accessibility,
      registrationStatus,
      open: event.open,
    },
  });
});
