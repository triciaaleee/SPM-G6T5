import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fetchEventBookingInfo } from "../lib/eventsClient.js";
import { fetchUnitsByCatalogId, unitsBlocked } from "../lib/equipmentConflicts.js";
import { unusableUnitsInWindow } from "../lib/unitUnavailability.js";
import { occupiedWindow } from "../lib/scheduleWindow.js";
import { validateAvailabilityQuery } from "../lib/validateAvailabilityQuery.js";

/**
 * E5-4: Technical Support check whether enough suitable equipment is free
 * for an event's date/time before committing to it (AC1-3). Read-only —
 * reserving equipment is a separate story (E5-6, routes/equipmentRequests.ts
 * PATCH), which is also what actually writes to equipment_booking (claiming
 * specific units when an item is marked Arranged/Partially Fulfilled).
 *
 * Availability is counted from the units themselves (shared with E5-6 via
 * lib/equipmentConflicts.ts): the units of the item, minus those out of use
 * for the event's dates (AC2), minus those booked for an overlapping event
 * (AC1). There is no stored stock counter in the sum (migration 0051), so a
 * unit reserved for another day still counts as free here.
 */
export const equipmentAvailabilityRouter = Router();

equipmentAvailabilityRouter.use(requireAuth);

/**
 * AC1: how many usable units of `type` are free for `eventId`'s own
 * date/time. AC2: units marked Damaged/Under Maintenance never count — whether
 * by status (unusable indefinitely) or by a period (E5-5) that overlaps this
 * event. AC3: the shortfall against `quantity`, if any.
 */
equipmentAvailabilityRouter.get("/", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  if (user.role !== "technical_support") {
    res.status(403).json({ error: "Only Technical Support can check equipment availability" });
    return;
  }

  const result = validateAvailabilityQuery(req.query as Record<string, unknown>);
  if (!result.valid) {
    res.status(400).json({ error: "Validation failed", fields: result.fields });
    return;
  }
  const { eventId, type, quantity } = result.value!;

  const targetInfo = await fetchEventBookingInfo([eventId], req.headers.authorization!);
  if (targetInfo.status === "error") {
    res.status(502).json({ error: "Failed to load the event" });
    return;
  }
  const targetEvent = targetInfo.events[0];
  if (!targetEvent) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const targetWindow = occupiedWindow(targetEvent);
  if (!targetWindow) {
    res.status(409).json({ error: "This event has no date or time set yet, so availability can't be checked." });
    return;
  }

  let catalogRow: { id: number } | null;
  let equipmentRows: { id: number; status: string }[];
  try {
    const catalogResult = await supabase.from("equipment_catalog").select("id").eq("name", type).maybeSingle();
    if (catalogResult.error) {
      res.status(500).json({ error: "Failed to load the equipment catalog" });
      return;
    }
    catalogRow = catalogResult.data;
    // Units belong to a catalog item by id (migration 0048), so a type that
    // isn't in the catalog has none.
    equipmentRows = catalogRow ? await fetchUnitsByCatalogId(supabase, catalogRow.id) : [];
  } catch {
    res.status(500).json({ error: "Failed to load equipment" });
    return;
  }

  const totalUnits = equipmentRows.length;
  const availableIds = equipmentRows.filter((row) => row.status === "Available").map((row) => row.id);

  // E5-5: a period overlapping the event's date takes a unit out too.
  let unusableInWindow: Set<number>;
  try {
    unusableInWindow = await unusableUnitsInWindow(supabase, availableIds, targetWindow);
  } catch {
    res.status(500).json({ error: "Failed to load equipment unavailability" });
    return;
  }
  const usableIds = availableIds.filter((id) => !unusableInWindow.has(id));
  const unusableCount = totalUnits - usableIds.length;

  let reservedElsewhereCount: number;
  try {
    // AC1: "reserved for ANOTHER event" — this event's own existing claims
    // (if any) don't count against its own availability.
    const blocked = await unitsBlocked(supabase, usableIds, targetWindow, req.headers.authorization!, {
      eventId,
      treatOwnEventClaimsAsBlocking: false,
    });
    reservedElsewhereCount = blocked.size;
  } catch {
    res.status(500).json({ error: "Failed to load equipment bookings" });
    return;
  }

  const availableCount = Math.max(0, usableIds.length - reservedElsewhereCount);
  const shortfall = Math.max(0, quantity - availableCount);

  res.json({
    event: { id: targetEvent.id, name: targetEvent.name },
    type,
    requestedQuantity: quantity,
    totalUnits,
    unusableCount,
    reservedElsewhereCount,
    availableCount,
    shortfall,
  });
});
