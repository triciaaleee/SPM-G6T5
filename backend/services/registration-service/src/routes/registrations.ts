import { Router } from "express";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { REGISTRATION_STATUS } from "../lib/registrationStatus.js";
import type { RegistrationStatus } from "../lib/registrationStatus.js";
import { canViewEvent, fetchAttendeeEvents, fetchOpenEvents } from "../lib/eventsClient.js";
import type { AttendeeEventInfo } from "../lib/eventsClient.js";
import { fetchVenueNames } from "../lib/venuesClient.js";
import { fetchUserNames } from "../lib/usersClient.js";
import { getPublisher } from "../lib/rabbitPublisher.js";

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

/** additional_info is free-form, so cap it rather than let one row grow without bound. */
const MAX_ADDITIONAL_INFO_CHARS = 5000;

/** events.id is a Postgres integer: a bigger id would make the query error rather than find nothing. */
const MAX_EVENT_ID = 2147483647;

const CLOSED_REPLY = { error: "Registration for this event is closed", code: "closed" };

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
  const text = String(Array.isArray(raw) ? raw[0] : raw);
  if (!/^[1-9]\d*$/.test(text)) return null;
  const id = Number(text);
  return id <= MAX_EVENT_ID ? id : null;
}

/**
 * How many Registered places each event has, across every attendee. Only
 * the count leaves this service — never who holds the places.
 */
async function countRegistered(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  eventIds: number[],
): Promise<{ ok: true; counts: Map<number, number> } | { ok: false }> {
  const counts = new Map<number, number>();
  if (eventIds.length === 0) return { ok: true, counts };

  const { data, error } = await supabase
    .from("registrations")
    .select("event_id")
    .eq("status", REGISTRATION_STATUS.registered)
    .in("event_id", eventIds);
  if (error) return { ok: false };

  for (const { event_id } of (data ?? []) as { event_id: number }[]) {
    counts.set(event_id, (counts.get(event_id) ?? 0) + 1);
  }
  return { ok: true, counts };
}

/** Places still free; null when the event has no cap. */
function slotsLeft(capacity: number | null | undefined, registered: number): number | null {
  return capacity == null ? null : Math.max(0, capacity - registered);
}

/**
 * The state attendees see: events-service's NOT_OPEN / OPEN / CLOSED, with an
 * OPEN event that has no places left shown as FULL (this service owns the count).
 */
function attendeeState(event: AttendeeEventInfo, slots: number | null): string | undefined {
  return event.registrationState === "OPEN" && slots === 0 ? "FULL" : event.registrationState;
}

/** Ids of the events that have a cap — the only ones worth counting. */
function cappedEventIds(events: AttendeeEventInfo[]): number[] {
  return events.filter((event) => event.capacity != null).map((event) => event.id);
}

/** undefined/null → no info; a plain object within the size cap → itself; anything else → invalid. */
function parseAdditionalInfo(raw: unknown): { ok: true; value: Record<string, unknown> | null } | { ok: false } {
  if (raw == null) return { ok: true, value: null };
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

  const venues = await fetchVenueNames(eventIds, req.headers.authorization!);
  if (venues.status === "error") {
    res.status(502).json({ error: "Failed to load the events' venues" });
    return;
  }

  const registered = await countRegistered(supabase!, cappedEventIds(open.events));
  if (!registered.ok) {
    res.status(500).json({ error: "Failed to load registrations" });
    return;
  }

  res.json({
    events: open.events.map((event) => {
      const slots = slotsLeft(event.capacity, registered.counts.get(event.id) ?? 0);
      return {
        ...event,
        venues: venues.venuesByEvent.get(event.id) ?? [],
        organiserName: event.organiserName ?? null,
        capacity: event.capacity ?? null,
        slotsLeft: slots,
        registrationState: attendeeState(event, slots),
        registrationStatus: statusByEvent.get(event.id) ?? null,
      };
    }),
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

  if (req.params.userId !== user!.id) {
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
              organiserName: event.organiserName ?? null,
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
 * Register for an event. The event must be open, before and after the place
 * is saved. Registering again after a withdrawal reuses the same row (one row
 * per attendee per event), keeping its original created_at.
 */
// Stryker disable next-line StringLiteral: a mounted router's "/" and "" match the same path.
registrationsRouter.post("/", async (req: AuthedRequest, res) => {
  if (!requireAttendee(req, res)) return;
  const { supabase, user } = req;

  const eventId = parseEventId(req.body?.eventId);
  if (eventId === null) {
    res.status(400).json({ error: "eventId must be a positive integer", field: "eventId" });
    return;
  }

  const info = parseAdditionalInfo(req.body.additionalInfo);
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
    res.status(409).json(
      event.registrationState === "CLOSED"
        ? CLOSED_REPLY
        : { error: "This event is not open for registration", code: "not_open" },
    );
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

  if ((existing as RegistrationRow | null)?.status === REGISTRATION_STATUS.registered) {
    alreadyRegistered();
    return;
  }

  // The count and the write happen together inside register_for_event
  // (migration 0040), serialised per event, so two attendees going for the
  // last place can't both get in. Re-registering after a withdrawal reuses
  // the same row: new additional_info replaces the old; leaving it out keeps
  // what was there.
  const { data: outcome, error: registerError } = await supabase!.rpc("register_for_event", {
    p_event_id: eventId,
    p_user_id: user!.id,
    p_capacity: event.capacity ?? null,
    p_additional_info: info.value,
    p_set_info: req.body.additionalInfo !== undefined,
  });
  if (registerError) {
    res.status(500).json({ error: "Failed to register" });
    return;
  }
  if (outcome === "already_registered") {
    alreadyRegistered();
    return;
  }
  if (outcome === "full") {
    res.status(409).json({ error: "This event is full", code: "event_full" });
    return;
  }

  // The event may have closed since the check above. A cancellation is written before its message goes out,
  // so either the event.cancelled handler sees this place, or this check sees the cancellation.
  const recheck = await fetchAttendeeEvents([eventId], req.headers.authorization!);
  const closedSince = recheck.status === "ok" && !recheck.events.find((e) => e.id === eventId)?.open;
  if (closedSince) {
    const { error: undoError } = existing
      ? await supabase!
          .from("registrations")
          .update({
            status: (existing as RegistrationRow).status,
            additional_info: (existing as RegistrationRow).additional_info,
          })
          .eq("registration_id", (existing as RegistrationRow).registration_id)
      : await supabase!.from("registrations").delete().eq("event_id", eventId).eq("user_id", user!.id);
    if (undoError) {
      console.error(`registration-service: couldn't undo a registration for closed event ${eventId} (${user!.id})`, undoError);
      res.status(500).json({ error: "Failed to register" });
      return;
    }
    res.status(409).json(CLOSED_REPLY);
    return;
  }

  const { data: saved, error: loadError } = await supabase!
    .from("registrations")
    .select(REGISTRATION_COLUMNS)
    .eq("event_id", eventId)
    .eq("user_id", user!.id)
    .single();
  if (loadError || !saved) {
    res.status(500).json({ error: "Failed to register" });
    return;
  }

  // E6-3 / #105 row 6: confirms the attendee's own registration.
  await getPublisher().publish({
    type: "registration.confirmed",
    eventId,
    actorId: user!.id,
    recipients: { userIds: [user!.id], roles: [] },
    data: { eventName: event.name },
  });

  res.status(existing ? 200 : 201).json({ registration: toRegistration(saved as RegistrationRow) });
});

/**
 * Give up a place (E6-4). The row is kept as Withdrawn rather than deleted,
 * and the place is free at once (only Registered rows are counted). Allowed
 * any time before the event starts — even inside the last 5 days, when
 * registration itself has closed; the freed place stays unavailable then
 * unless the coordinator forces registration open (AGENTS.md §3b).
 */
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
  if ((existing as RegistrationRow).status === REGISTRATION_STATUS.cancelled) {
    res.status(409).json({ error: "This event was cancelled by the organiser", code: "event_cancelled" });
    return;
  }

  const events = await fetchAttendeeEvents([eventId], req.headers.authorization!);
  if (events.status === "error") {
    res.status(502).json({ error: "Failed to load the event" });
    return;
  }
  const event = events.events.find((e) => e.id === eventId);
  if (event?.hasStarted) {
    res.status(409).json({
      error: "This event has already started, so you can no longer withdraw",
      code: "event_started",
    });
    return;
  }

  const { data: updated, error: updateError } = await supabase!
    .from("registrations")
    .update({ status: REGISTRATION_STATUS.withdrawn })
    .eq("registration_id", (existing as RegistrationRow).registration_id)
    // The event was fetched since the place was read, so the organiser may have cancelled it by now (`Cancelled` is final, §3b).
    .eq("status", REGISTRATION_STATUS.registered)
    .select(REGISTRATION_COLUMNS)
    .maybeSingle();
  if (updateError) {
    res.status(500).json({ error: "Failed to withdraw" });
    return;
  }
  if (!updated) {
    res.status(409).json({ error: "You no longer hold a place for this event", code: "no_place" });
    return;
  }

  // E6-4 / #105 row 7: confirms the attendee's own withdrawal, naming the event.
  await getPublisher().publish({
    type: "registration.withdrawn",
    eventId,
    actorId: user!.id,
    recipients: { userIds: [user!.id], roles: [] },
    data: event?.name ? { eventName: event.name } : {},
  });

  res.json({ registration: toRegistration(updated as RegistrationRow) });
});

/**
 * What an attendee sees when they open an event: name, description, date,
 * time, venue(s) and their own registration status — and nothing else.
 *
 * Access: allowed if they hold a Registered place, or held one when the
 * organiser cancelled the event (Cancelled — E6-4, so they can see what
 * happened), or if registration has opened for the event, even if it is now
 * full or closed (so they can look before signing up). Otherwise denied — an
 * event that isn't listed, that they hold no place for, is indistinguishable
 * from one that doesn't exist.
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

  const hasPlace =
    registrationStatus === REGISTRATION_STATUS.registered || registrationStatus === REGISTRATION_STATUS.cancelled;
  if (!event || (!hasPlace && !(event.viewable ?? event.listed ?? event.open))) {
    console.warn(`Attendee ${user!.id} denied access to event ${eventId} (not registered, not listed)`);
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const venues = await fetchVenueNames([eventId], authorization);
  if (venues.status === "error") {
    res.status(502).json({ error: "Failed to load the event's venue" });
    return;
  }

  const registered = await countRegistered(supabase!, cappedEventIds([event]));
  if (!registered.ok) {
    res.status(500).json({ error: "Failed to load the event" });
    return;
  }

  const slots = slotsLeft(event.capacity, registered.counts.get(eventId) ?? 0);
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
      organiserName: event.organiserName ?? null,
      capacity: event.capacity ?? null,
      slotsLeft: slots,
      registrationNeeded: event.registrationNeeded,
      registrationState: attendeeState(event, slots),
      registrationStatus,
      open: event.open,
      hasStarted: event.hasStarted ?? false,
    },
  });
});
