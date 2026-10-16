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

export interface EquipmentUnitRow {
  id: number;
  status: string;
}

/** Every physical unit of `type`, whatever its condition. */
export async function fetchUnitsByType(supabase: any, type: string): Promise<EquipmentUnitRow[]> {
  const { data, error } = await supabase.from("equipment").select("id, status").eq("type", type);
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

  let query = supabase.from("equipment_booking").select("equipment_id, event_id").in("equipment_id", usableIds);
  if (!options.treatOwnEventClaimsAsBlocking) {
    query = query.neq("event_id", options.eventId);
  }
  const { data, error } = await query;
  if (error) throw new Error("Failed to load equipment bookings");

  const bookings = (data ?? []) as { equipment_id: number; event_id: number }[];
  const otherEventIds = [...new Set(bookings.map((b) => b.event_id).filter((id) => id !== options.eventId))];

  const otherInfo = otherEventIds.length > 0 ? await fetchEventBookingInfo(otherEventIds, authorization) : { status: "ok" as const, events: [] };
  const otherEventsById = new Map(otherInfo.status === "ok" ? otherInfo.events.map((e) => [e.id, e]) : []);

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
  type: string,
  quantity: number,
  eventId: number,
  targetWindow: OccupiedWindow,
  authorization: string,
  alreadyClaimed: ReadonlySet<number> = new Set(),
): Promise<ClaimResult> {
  const units = await fetchUnitsByType(supabase, type);
  const usableIds = units.filter((u) => u.status === "Available").map((u) => u.id);
  const blocked = await unitsBlocked(supabase, usableIds, targetWindow, authorization, {
    eventId,
    treatOwnEventClaimsAsBlocking: true,
  });
  const freeIds = usableIds.filter((id) => !blocked.has(id) && !alreadyClaimed.has(id));
  const claimedIds = freeIds.slice(0, quantity);
  return { claimedIds, availableCount: freeIds.length, shortfall: Math.max(0, quantity - freeIds.length) };
}

/** Releases up to `count` of this item's claimed units (arbitrary which, they're interchangeable). */
export async function releaseUnitsForItem(supabase: any, itemId: number, count: number): Promise<void> {
  if (count <= 0) return;

  const { data, error } = await supabase
    .from("equipment_booking")
    .select("id")
    .eq("request_item_id", itemId)
    .order("id", { ascending: true })
    .limit(count);
  if (error) throw new Error("Failed to load equipment bookings to release");

  const ids = ((data ?? []) as { id: number }[]).map((row) => row.id);
  if (ids.length === 0) return;

  const { error: deleteError } = await supabase.from("equipment_booking").delete().in("id", ids);
  if (deleteError) throw new Error("Failed to release equipment bookings");
}

/** Claims `claimedIds` for `itemId`/`eventId` — call only after the stock move itself has committed. */
export async function recordClaims(supabase: any, itemId: number, eventId: number, claimedIds: number[]): Promise<void> {
  if (claimedIds.length === 0) return;
  const { error } = await supabase
    .from("equipment_booking")
    .insert(claimedIds.map((equipmentId) => ({ equipment_id: equipmentId, event_id: eventId, request_item_id: itemId })));
  if (error) throw new Error("Failed to record equipment reservation");
}
