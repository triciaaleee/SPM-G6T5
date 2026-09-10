import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";

export const eventsRouter = Router();

eventsRouter.use(requireAuth);

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

  const { data, error } = await supabase
    .from("events")
    .select("id, status, submitted_details, coordinator_id, review_outcome, created_at")
    .eq("organiser_id", user.id);

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

  const eventId = req.params.id;

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
    await supabase.from("access_denials").insert({
      user_id: user.id,
      event_id: eventId,
      reason: "not_found_or_not_owner",
    });
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { organiser_id, ...event } = data;
  res.json({ event });
});
