import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fetchEventBookingInfo } from "../lib/eventsClient.js";
import { fetchUnitsByType, unitsBlocked } from "../lib/equipmentConflicts.js";
import { occupiedWindow } from "../lib/scheduleWindow.js";
import { validateAvailabilityQuery } from "../lib/validateAvailabilityQuery.js";

/**
 * E5-4: Technical Support check whether enough suitable equipment is free
 * for an event's date/time before committing to it (AC1-3). Read-only —
 * reserving equipment is a separate story (E5-6, routes/equipmentRequests.ts
 * PATCH), which is also what actually writes to equipment_booking (claiming
 * specific units when an item is marked Arranged/Partially Fulfilled).
 *
 * equipment_catalog.available_stock (migration 0022) is still the baseline
 * here — it's the one number guaranteed to reflect every arrangement E5-3
 * has made, including requests from before E5-6 existed. The per-unit
 * tables (shared with E5-6 via lib/equipmentConflicts.ts) layer AC2's
 * damaged/maintenance exclusion and AC1's overlapping-booking exclusion on
 * top of that baseline.
 */
export const equipmentAvailabilityRouter = Router();

equipmentAvailabilityRouter.use(requireAuth);

/**
 * AC1: how many usable units of `type` are free for `eventId`'s own
 * date/time. AC2: units marked Damaged/Under Maintenance never count.
 * AC3: the shortfall against `quantity`, if any.
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

  let catalogRow: { available_stock: number } | null;
  let equipmentRows: { id: number; status: string }[];
  try {
    const [catalogResult, units] = await Promise.all([
      supabase.from("equipment_catalog").select("available_stock").eq("name", type).maybeSingle(),
      fetchUnitsByType(supabase, type),
    ]);
    if (catalogResult.error) {
      res.status(500).json({ error: "Failed to load the equipment catalog" });
      return;
    }
    catalogRow = catalogResult.data;
    equipmentRows = units;
  } catch {
    res.status(500).json({ error: "Failed to load equipment" });
    return;
  }

  const totalUnits = equipmentRows.length;
  const usableIds = equipmentRows.filter((row) => row.status === "Available").map((row) => row.id);
  const unusableCount = totalUnits - usableIds.length;

  let reservedElsewhereCount = 0;
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

  // The catalog's own count if this type is in it (the real, live-updated
  // number — see the file comment). It doesn't know about damaged/under-
  // maintenance units at all, so those are still subtracted on top.
  // Falling back to the raw unit count (no catalog entry for this type)
  // needs no such subtraction — `usableIds` is already filtered to
  // Available, so subtracting unusableCount again would double-count it.
  const catalogAvailableStock = catalogRow?.available_stock ?? null;
  const availableCount =
    catalogAvailableStock !== null
      ? Math.max(0, catalogAvailableStock - unusableCount - reservedElsewhereCount)
      : Math.max(0, usableIds.length - reservedElsewhereCount);
  const shortfall = Math.max(0, quantity - availableCount);

  res.json({
    event: { id: targetEvent.id, name: targetEvent.name },
    type,
    requestedQuantity: quantity,
    totalUnits,
    catalogAvailableStock,
    unusableCount,
    reservedElsewhereCount,
    availableCount,
    shortfall,
  });
});
