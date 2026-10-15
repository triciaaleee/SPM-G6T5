import type { AuthedRequest } from "../middleware/auth.js";

type Supabase = NonNullable<AuthedRequest["supabase"]>;

/**
 * E3-6 / E5-6 AC4: releases every equipment reservation held for an event
 * — `release_equipment_for_event` (migration 0027) resets each item's
 * `quantity_fulfilled`, returns the stock to `equipment_catalog`, and
 * deletes the event's `equipment_booking` rows. Shared by the organiser's
 * direct REST release (`POST /events/:eventId/release`, gated on the
 * event already being Cancelled) and the `event.cancelled` consumer
 * below, so the actual release logic lives in one place.
 */
export async function releaseEquipmentForEvent(supabase: Supabase, eventId: number): Promise<void> {
  const { error } = await supabase.rpc("release_equipment_for_event", { p_event_id: eventId });
  if (error) throw error;
}
