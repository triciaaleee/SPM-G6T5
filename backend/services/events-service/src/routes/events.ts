import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { validateEventRequest } from "../lib/validateEventRequest.js";
import { isPositiveInteger } from "../lib/validation.js";

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
 * story's acceptance criteria, then inserts with status "Requested".
 * Authorization is enforced here in application code — the service-role
 * client bypasses RLS, so organiser_id is always set from the verified
 * JWT's subject, never trusted from the request body.
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
 * List events. Coordinators get full pipeline visibility (all events);
 * everyone else sees only events they organised. Since the service-role
 * client bypasses RLS, this filter is the actual enforcement, not just
 * defense-in-depth.
 */
eventsRouter.get("/", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  let query = supabase
    .from("events")
    .select("id, status, submitted_details, coordinator_id, review_outcome, created_at");

  if (user.role !== "coordinator") {
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
 * Fetch a single event by id. The service-role client returns any row
 * regardless of ownership, so ownership/role is checked explicitly here;
 * a non-owner (and non-coordinator) request is treated the same as
 * "not found" and the attempt is recorded for audit purposes.
 */
eventsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!isPositiveInteger(eventId)) {
    await recordAccessDenial(supabase, user.id, eventId, "invalid_id_format");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .select("id, status, submitted_details, coordinator_id, review_outcome, created_at, organiser_id")
    .eq("id", Number(eventId))
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: "Failed to load event" });
    return;
  }

  const isOwner = data?.organiser_id === user.id;
  const isCoordinator = user.role === "coordinator";

  if (!data || (!isOwner && !isCoordinator)) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { organiser_id, ...event } = data;
  res.json({ event });
});
