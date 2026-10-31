/**
 * E5-6 AC3: "Given a reservation exists, when the event's date, time or
 * duration changes, then the reservation is re-checked and flagged if it no
 * longer holds." There's no push from events-service when an event is
 * edited (no service in this codebase calls out on an event change — venue
 * availability is re-checked lazily too, e.g. "On Hold" expiry is "applied
 * when availability is checked", per AGENTS.md §3a), so this re-runs the
 * same conflict check every time a request is viewed, against each
 * involved event's CURRENT schedule.
 *
 * Claiming already prevents a conflict at the moment it happens (see
 * lib/equipmentConflicts.ts), so a flag can only appear afterwards: one of
 * two events whose claims didn't use to overlap had its date/time/duration
 * edited so that they now do.
 */

import { fetchEventBookingInfo } from "./eventsClient.js";
import { occupiedWindow, overlaps, type OccupiedWindow } from "./scheduleWindow.js";
import { fetchUnavailability, overlappingPeriods, type UnavailabilityRow } from "./unitUnavailability.js";

export interface ReservationFlag {
  flagged: boolean;
  reason: string | null;
}

const NO_FLAG: ReservationFlag = { flagged: false, reason: null };

/**
 * `itemEventIds` maps each request item being evaluated to the event it
 * belongs to. `knownWindows` is whatever event windows the caller already
 * resolved (e.g. from a batch venue-booking-info lookup it made anyway) —
 * anything missing is fetched here.
 */
export async function computeReservationFlags(
  supabase: any,
  itemEventIds: Map<number, number>,
  knownWindows: Map<number, OccupiedWindow>,
  authorization: string,
): Promise<Map<number, ReservationFlag>> {
  const itemIds = [...itemEventIds.keys()];
  const flags = new Map<number, ReservationFlag>(itemIds.map((id) => [id, NO_FLAG]));
  if (itemIds.length === 0) return flags;

  const { data: ownBookingRows, error: ownError } = await supabase
    .from("equipment_booking")
    .select("equipment_id, request_item_id")
    .eq("status", "Reserved")
    .in("request_item_id", itemIds);
  if (ownError) return flags;

  const ownBookings = (ownBookingRows ?? []) as { equipment_id: number; request_item_id: number }[];
  if (ownBookings.length === 0) return flags;

  const equipmentIds = [...new Set(ownBookings.map((b) => b.equipment_id))];
  const { data: allBookingRows, error: allError } = await supabase
    .from("equipment_booking")
    .select("equipment_id, event_id, request_item_id")
    .eq("status", "Reserved")
    .in("equipment_id", equipmentIds);
  if (allError) return flags;

  const allBookings = (allBookingRows ?? []) as { equipment_id: number; event_id: number; request_item_id: number }[];

  const neededEventIds = [...new Set(allBookings.map((b) => b.event_id))].filter((id) => !knownWindows.has(id));
  const windows = new Map(knownWindows);
  // Stryker disable next-line ConditionalExpression,EqualityOperator: fetchEventBookingInfo([]) answers without a request, so asking for no events is the same as skipping the call
  if (neededEventIds.length > 0) {
    const info = await fetchEventBookingInfo(neededEventIds, authorization);
    if (info.status === "ok") {
      for (const event of info.events) {
        const window = occupiedWindow(event);
        if (window) windows.set(event.id, window);
      }
    }
  }

  // E5-5: periods Technical Support marked on the units this event holds.
  let periodsByUnit = new Map<number, UnavailabilityRow[]>();
  // Stryker disable BlockStatement: fetchUnavailability throws before periodsByUnit is touched, so it is still empty in the catch
  try {
    const periods = await fetchUnavailability(supabase, [...new Set(ownBookings.map((b) => b.equipment_id))]);
    for (const period of periods) {
      periodsByUnit.set(period.equipment_id, [...(periodsByUnit.get(period.equipment_id) ?? []), period]);
    }
  } catch {
    periodsByUnit = new Map();
  }

  // Stryker restore BlockStatement
  for (const booking of ownBookings) {
    const ownEventId = itemEventIds.get(booking.request_item_id);
    if (ownEventId === undefined) continue;
    const ownWindow = windows.get(ownEventId);
    if (!ownWindow) continue;

    const unusable = overlappingPeriods(periodsByUnit.get(booking.equipment_id) ?? [], ownWindow).get(booking.equipment_id);
    if (unusable) {
      flags.set(booking.request_item_id, {
        flagged: true,
        reason: `A reserved unit is unavailable (${unusable.reason}) during this event, so it needs a replacement.`,
      });
      continue;
    }

    const rivals = allBookings.filter(
      (b) => b.equipment_id === booking.equipment_id && b.request_item_id !== booking.request_item_id && b.event_id !== ownEventId,
    );

    const conflicted = rivals.some((rival) => {
      const rivalWindow = windows.get(rival.event_id);
      return !rivalWindow || overlaps(ownWindow, rivalWindow);
    });

    if (conflicted) {
      flags.set(booking.request_item_id, {
        flagged: true,
        reason: "This event's schedule now conflicts with another event's claim on the same reserved equipment unit.",
      });
    }
  }

  return flags;
}
