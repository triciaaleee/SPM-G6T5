import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { fetchEventBookingInfo } from "../lib/eventsClient.js";
import { occupiedWindow, overlaps } from "../lib/scheduleWindow.js";
import { validateAvailabilityQuery } from "../lib/validateAvailabilityQuery.js";

/**
 * E5-4: Technical Support check whether enough suitable equipment is free
 * for an event's date/time before committing to it (AC1-3). Read-only —
 * reserving equipment is a separate story (E5-6).
 *
 * equipment_catalog.available_stock (migration 0022) is the number that
 * actually moves today — it drops when E5-3 marks a request Arranged or
 * Partially Fulfilled, which is the real commitment mechanism in this app
 * right now. equipment_booking (this migration's per-unit, date-aware
 * table) only gets written by E5-6 (not built yet), so on its own it would
 * report "available" even when the catalog is fully spoken for. The
 * catalog's count is therefore the baseline; the per-unit tables layer
 * AC2's damaged/maintenance exclusion and AC1's overlapping-booking
 * exclusion on top, for whichever units can be resolved today.
 */
export const equipmentAvailabilityRouter = Router();

equipmentAvailabilityRouter.use(requireAuth);

interface EquipmentRow {
  id: number;
  status: string;
}

interface BookingRow {
  equipment_id: number;
  event_id: number;
}

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

  const [{ data: catalogRow, error: catalogError }, { data: equipmentRows, error: equipmentError }] = await Promise.all([
    supabase.from("equipment_catalog").select("available_stock").eq("name", type).maybeSingle(),
    supabase.from("equipment").select("id, status").eq("type", type),
  ]);

  if (catalogError) {
    res.status(500).json({ error: "Failed to load the equipment catalog" });
    return;
  }
  if (equipmentError) {
    res.status(500).json({ error: "Failed to load equipment" });
    return;
  }

  const rows = (equipmentRows ?? []) as EquipmentRow[];
  const totalUnits = rows.length;
  const usableIds = rows.filter((row) => row.status === "Available").map((row) => row.id);
  const unusableCount = totalUnits - usableIds.length;

  let reservedElsewhereCount = 0;

  if (usableIds.length > 0) {
    const { data: bookingRows, error: bookingError } = await supabase
      .from("equipment_booking")
      .select("equipment_id, event_id")
      .in("equipment_id", usableIds)
      .neq("event_id", eventId);

    if (bookingError) {
      res.status(500).json({ error: "Failed to load equipment bookings" });
      return;
    }

    const bookings = (bookingRows ?? []) as BookingRow[];
    const otherEventIds = [...new Set(bookings.map((booking) => booking.event_id))];

    if (otherEventIds.length > 0) {
      const otherInfo = await fetchEventBookingInfo(otherEventIds, req.headers.authorization!);
      const otherEventsById = new Map(otherInfo.status === "ok" ? otherInfo.events.map((event) => [event.id, event]) : []);

      const reservedUnitIds = new Set<number>();
      for (const booking of bookings) {
        if (reservedUnitIds.has(booking.equipment_id)) continue;

        const otherEvent = otherEventsById.get(booking.event_id);
        const otherWindow = otherEvent ? occupiedWindow(otherEvent) : null;
        // Can't resolve the other booking's own schedule (events-service
        // didn't return it, or it has no date/time) — can't rule out a
        // conflict, so it's treated as blocking rather than over-promising
        // this unit (AC1's "do not over-commit").
        const conflicts = !otherWindow || overlaps(targetWindow, otherWindow);
        if (conflicts) reservedUnitIds.add(booking.equipment_id);
      }
      reservedElsewhereCount = reservedUnitIds.size;
    }
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
