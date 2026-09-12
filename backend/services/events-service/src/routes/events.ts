import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { validateEventRequest } from "../lib/validateEventRequest.js";
import { isUuid } from "../lib/validation.js";

async function recordAccessDenial(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  userId: string,
  eventId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from("access_denials")
    .insert({ user_id: userId, event_id: eventId, reason });

  if (error) {
    console.error("Failed to record access_denials row", { userId, eventId, reason, error });
  }
}

export const eventsRouter = Router();

eventsRouter.use(requireAuth);

/**
 * E2-1: submit a new event request. Validates the mandatory fields per the
 * story's acceptance criteria, then inserts with status "Requested" — RLS
 * (organisers_insert_own_events) still enforces organiser_id = auth.uid()
 * at the DB layer.
 */
eventsRouter.post("/", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const result = validateEventRequest(req.body ?? {});
  if (!result.valid) {
    res.status(400).json({ error: "Validation failed", fields: result.fields });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .insert({
      organiser_id: user.id,
      status: "Requested",
      submitted_details: result.value,
    })
    .select("id, status, submitted_details, coordinator_id, review_outcome, created_at")
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to submit event request" });
    return;
  }

  res.status(201).json({ event: data, message: "Your event request has been submitted." });
});

/**
 * List events belonging to the authenticated organiser only.
 * RLS on the events table already restricts rows to organiser_id = auth.uid();
 * the explicit filter here is defense-in-depth, not the primary control.
 */
eventsRouter.get("/", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const isCoordinator = user.role === "coordinator";

  let query = supabase
    .from("events")
    .select("id, status, submitted_details, coordinator_id, review_outcome, created_at");

  if (!isCoordinator) {
    query = query.eq("organiser_id", user.id);
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: "Failed to load events" });
    return;
  }

  res.json({ events: data });
});

/**
 * Fetch a single event by id. RLS guarantees a non-owner query returns no
 * row, which is indistinguishable at the DB level from "not found" — so we
 * treat both as 403 and record the attempt for audit purposes.
 */
eventsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!isUuid(eventId)) {
    await recordAccessDenial(supabase, user.id, eventId, "invalid_id_format");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .select("id, status, submitted_details, coordinator_id, review_outcome, created_at, organiser_id")
    .eq("id", eventId)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to load event" });
    return;
  }

  if (!data) {
    if (user.role === "coordinator") {
      // Coordinators can see all events via RLS, so !data means the event
      // genuinely does not exist — not an access violation.
      res.status(404).json({ error: "Event not found" });
      return;
    }
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { organiser_id, ...event } = data;
  res.json({ event });
});
