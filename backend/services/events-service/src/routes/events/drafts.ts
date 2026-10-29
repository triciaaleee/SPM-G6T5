import { Router } from "express";
import type { AuthedRequest } from "../../middleware/auth.js";
import { normaliseDraftEventRequest } from "../../lib/validateEventRequest.js";
import { isPositiveInteger } from "../../lib/validation.js";
import { recordAccessDenial, EVENT_COLUMNS } from "./shared.js";

/**
 * Drafts controller: organisers save, resume and delete unsubmitted drafts.
 * Nobody else sees a draft until it is submitted (Draft -> Unassigned).
 */

export const draftsRouter = Router();

/**
 * E2-4 AC1: save a new draft. Skips E2-1's validation entirely — a draft
 * may be missing any or all of its mandatory fields — and never assigns a
 * coordinator, since a draft hasn't reached the review pipeline yet.
 */
draftsRouter.post("/draft", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  if (user.role === "attendee") {
    res.status(403).json({ error: "Attendees cannot manage events" });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .insert({
      organiser_id: user.id,
      status: "Draft",
      submitted_details: normaliseDraftEventRequest(req.body ?? {}),
    })
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to save draft" });
    return;
  }

  res.status(201).json({ event: data });
});

/**
 * E2-4 AC1/AC2: save progress on an existing draft without submitting it —
 * same relaxed validation as creating one. Only the owning organiser may
 * update it, and only while it's still a draft (once submitted, further
 * changes go through the normal PATCH /:id edit rules instead).
 */
draftsRouter.patch("/:id/draft", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const { data: existing, error: fetchError } = await supabase
    .from("events")
    .select("id, status, organiser_id")
    .eq("id", Number(eventId))
    .maybeSingle();

  if (fetchError) {
    res.status(500).json({ error: "Failed to load draft" });
    return;
  }

  if (!existing || existing.organiser_id !== user.id) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  if (existing.status !== "Draft") {
    res.status(409).json({ error: "This request is no longer a draft" });
    return;
  }

  const { data, error } = await supabase
    .from("events")
    .update({ submitted_details: normaliseDraftEventRequest(req.body ?? {}) })
    .eq("id", existing.id)
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    res.status(500).json({ error: "Failed to save draft" });
    return;
  }

  res.json({ event: data });
});

/**
 * E2-5.2 AC1: delete a draft. Same ownership/status guard as the draft
 * PATCH above — only the owning organiser, and only while it's still a
 * draft (a submitted request isn't deletable through this route).
 */
draftsRouter.delete("/:id/draft", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const { data: existing, error: fetchError } = await supabase
    .from("events")
    .select("id, status, organiser_id")
    .eq("id", Number(eventId))
    .maybeSingle();

  if (fetchError) {
    res.status(500).json({ error: "Failed to load draft" });
    return;
  }

  if (!existing || existing.organiser_id !== user.id) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  if (existing.status !== "Draft") {
    res.status(409).json({ error: "This request is no longer a draft" });
    return;
  }

  const { error } = await supabase.from("events").delete().eq("id", existing.id);

  if (error) {
    res.status(500).json({ error: "Failed to delete draft" });
    return;
  }

  res.status(204).send();
});
