/**
 * Shared per-unit conflict logic for `equipment` + `equipment_booking`,
 * used by both E5-4's read-only availability check (routes/
 * equipmentAvailability.ts) and E5-6's actual reservation claim/release
 * (routes/equipmentRequests.ts). Sharing is within equipment-service only —
 * AGENTS.md §1's "no shared code imports between services" is about
 * cross-service imports, not a service's own lib files.
 */

import { fetchEventBookingInfo } from "./eventsClient.js";
import { occupiedWindow, overlaps, type OccupiedWindow } from "./scheduleWindow.js";
import { unusableUnitsInWindow } from "./unitUnavailability.js";

export interface EquipmentUnitRow {
  id: number;
  status: string;
}

/** Every physical unit of one catalog item, whatever its condition. */
export async function fetchUnitsByCatalogId(supabase: any, catalogId: number): Promise<EquipmentUnitRow[]> {
  const { data, error } = await supabase.from("equipment").select("id, status").eq("equipment_catalog_id", catalogId);
  if (error) throw new Error("Failed to load equipment");
  return (data ?? []) as EquipmentUnitRow[];
}

export interface BlockingOptions {
  /** The event being checked/claimed for. */
  eventId: number;
  /**
   * E5-4 (check only, AC1): "reserved for ANOTHER event" — a unit already
   * tied to this same event doesn't count against its own availability.
   * E5-6 (claim): a unit already tied to this event by a *different* item
   * is not free to hand to a second item for the same window — one
   * physical unit can't serve two claims at once, even within one event —
   * so an own-event claim DOES block a new claim.
   */
  treatOwnEventClaimsAsBlocking: boolean;
  /**
   * Write each other event's current window onto its bookings (migration 0050),
   * so reserve_equipment_request can refuse overlaps itself and a rescheduled
   * event's stored window catches up. Best-effort; only a claim sets it.
   */
  refreshStoredWindows?: boolean;
}

/**
 * Which of `usableIds` are already booked in a way that overlaps
 * `targetWindow`. An other booking whose owning event's schedule can't be
 * resolved is treated as blocking rather than over-promising the unit
 * (same conservative stance as E5-4).
 */
export async function unitsBlocked(
  supabase: any,
  usableIds: number[],
  targetWindow: OccupiedWindow,
  authorization: string,
  options: BlockingOptions,
): Promise<Set<number>> {
  if (usableIds.length === 0) return new Set();

  let query = supabase.from("equipment_booking").select("equipment_id, event_id, window_start_ms, window_end_ms")
    .eq("status", "Reserved")
    .in("equipment_id", usableIds);
  if (!options.treatOwnEventClaimsAsBlocking) {
    query = query.neq("event_id", options.eventId);
  }
  const { data, error } = await query;
  if (error) throw new Error("Failed to load equipment bookings");

  const bookings = (data ?? []) as {
    equipment_id: number;
    event_id: number;
    window_start_ms: number | null;
    window_end_ms: number | null;
  }[];
  const otherEventIds = [...new Set(bookings.map((b) => b.event_id).filter((id) => id !== options.eventId))];

  const otherInfo = otherEventIds.length > 0 ? await fetchEventBookingInfo(otherEventIds, authorization) : { status: "ok" as const, events: [] };
  const otherEventsById = new Map(otherInfo.status === "ok" ? otherInfo.events.map((e) => [e.id, e]) : []);

  if (options.refreshStoredWindows) {
    const stale = new Map<number, OccupiedWindow>();
    for (const booking of bookings) {
      if (booking.event_id === options.eventId || stale.has(booking.event_id)) continue;
      const current = otherEventsById.has(booking.event_id) ? occupiedWindow(otherEventsById.get(booking.event_id)!) : null;
      if (current && (booking.window_start_ms !== current.startMs || booking.window_end_ms !== current.endMs)) {
        stale.set(booking.event_id, current);
      }
    }
    for (const [eventId, window] of stale) {
      // Best-effort: a failed write only leaves the old window, which the checks below don't rely on.
      await supabase
        .from("equipment_booking")
        .update({ window_start_ms: window.startMs, window_end_ms: window.endMs })
        .eq("event_id", eventId)
        .eq("status", "Reserved");
    }
  }

  const blocked = new Set<number>();
  for (const booking of bookings) {
    if (blocked.has(booking.equipment_id)) continue;

    if (booking.event_id === options.eventId) {
      // Only reachable when treatOwnEventClaimsAsBlocking is true — this
      // event's own window, so it always overlaps itself.
      blocked.add(booking.equipment_id);
      continue;
    }

    const otherEvent = otherEventsById.get(booking.event_id);
    const otherWindow = otherEvent ? occupiedWindow(otherEvent) : null;
    const conflicts = !otherWindow || overlaps(targetWindow, otherWindow);
    if (conflicts) blocked.add(booking.equipment_id);
  }
  return blocked;
}

export interface ClaimResult {
  /** Unit ids newly claimable for this request, up to `quantity`. */
  claimedIds: number[];
  /** How many usable, unblocked units exist in total (for AC2's shortfall message). */
  availableCount: number;
  shortfall: number;
}

/**
 * AC1/AC2: find up to `quantity` physical units of `type` that are
 * Available and not already committed to an overlapping window — claiming
 * a different item of the same event does not get to reuse a unit that
 * event already holds (treatOwnEventClaimsAsBlocking: true).
 *
 * `alreadyClaimed` covers units a *different* item has provisionally
 * claimed earlier in the same PATCH call — nothing is written to
 * equipment_booking until every item's claim has been checked (so the
 * stock move and the per-unit claim stay in step, see routes/
 * equipmentRequests.ts), so without this, two items of one call could
 * independently pick the very same still-unwritten unit.
 */
export async function claimUnits(
  supabase: any,
  catalogId: number,
  quantity: number,
  eventId: number,
  targetWindow: OccupiedWindow,
  authorization: string,
  alreadyClaimed: ReadonlySet<number> = new Set(),
): Promise<ClaimResult> {
  const units = await fetchUnitsByCatalogId(supabase, catalogId);
  // E5-5: a unit marked damaged or under maintenance for a period overlapping
  // the event is not offered, on top of one whose status is not Available.
  const availableIds = units.filter((u) => u.status === "Available").map((u) => u.id);
  const unusableInWindow = await unusableUnitsInWindow(supabase, availableIds, targetWindow);
  const usableIds = availableIds.filter((id) => !unusableInWindow.has(id));
  const blocked = await unitsBlocked(supabase, usableIds, targetWindow, authorization, {
    eventId,
    treatOwnEventClaimsAsBlocking: true,
    refreshStoredWindows: true,
  });
  const freeIds = usableIds.filter((id) => !blocked.has(id) && !alreadyClaimed.has(id));
  const claimedIds = freeIds.slice(0, quantity);
  return { claimedIds, availableCount: freeIds.length, shortfall: Math.max(0, quantity - freeIds.length) };
}
