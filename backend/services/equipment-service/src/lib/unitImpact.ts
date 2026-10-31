/**
 * E5-5: what marking units unusable for a period would do — which of them are
 * free, which are reserved (and for which events), and which are already out
 * of use. Used both for the preview Technical Support see before confirming and
 * for the notices sent when they do.
 */

import { fetchEventBookingInfo, type EquipmentBookingInfo } from "./eventsClient.js";
import { occupiedWindow, overlaps, type OccupiedWindow } from "./scheduleWindow.js";
import { fetchUnavailability, overlappingPeriods } from "./unitUnavailability.js";

export interface UnitRecord {
  id: number;
  type: string;
  /** Which catalog item this unit is (migration 0048); only loaded where a route needs to check it. */
  equipment_catalog_id?: number;
  status: string;
  label: string | null;
}

export interface AffectedEvent {
  eventId: number;
  eventName: string;
  proposedDate: string | null;
  startTime: string | null;
  /** The event's current coordinator, who is told when a unit they hold becomes unusable. */
  coordinatorId: string | null;
}

/** free: nothing reserved in the period. reserved: held for at least one event then. unavailable: already out of use, so not pickable. */
export type UnitState = "free" | "reserved" | "unavailable";

export interface ImpactUnit {
  id: number;
  label: string | null;
  state: UnitState;
  /** For `unavailable`: Damaged / Under Maintenance. */
  reason: string | null;
  /** The events (not yet over) holding this unit during the period. */
  events: AffectedEvent[];
}

export interface ImpactResult {
  units: ImpactUnit[];
  /** False when events-service couldn't be asked, so reservations couldn't be matched to events. */
  eventsOk: boolean;
}

/** Sortable start of an event: date then time; an unknown date sorts last. */
function startKey(event: AffectedEvent): string {
  // Stryker disable next-line StringLiteral: an unknown date sorts after every real one whichever fallback is used; the "00:00" fallback is covered by a test
  return `${event.proposedDate ?? "9999-12-31"}T${event.startTime ?? "00:00"}`;
}

/** Works out each unit's state for `period`. Throws if the database can't be read. */
export async function impactForUnits(
  supabase: any,
  authorization: string,
  units: UnitRecord[],
  period: OccupiedWindow,
): Promise<ImpactResult> {
  const ids = units.map((unit) => unit.id);
  if (ids.length === 0) return { units: [], eventsOk: true };

  const periods = await fetchUnavailability(supabase, ids);
  const outOfUse = overlappingPeriods(periods, period);

  const { data: bookingRows, error } = await supabase
    .from("equipment_booking")
    .select("equipment_id, event_id")
    .eq("status", "Reserved")
    .in("equipment_id", ids);
  if (error) throw new Error("Failed to load equipment bookings");
  const bookings = (bookingRows ?? []) as { equipment_id: number; event_id: number }[];

  const eventIds = [...new Set(bookings.map((b) => b.event_id))];
  let eventsOk = true;
  const infoById = new Map<number, EquipmentBookingInfo>();
  // Stryker disable next-line ConditionalExpression,EqualityOperator: fetchEventBookingInfo([]) answers without a request, so asking for no events is the same as skipping the call
  if (eventIds.length > 0) {
    const info = await fetchEventBookingInfo(eventIds, authorization);
    if (info.status === "ok") for (const event of info.events) infoById.set(event.id, event);
    else eventsOk = false;
  }

  const now = Date.now();
  const eventsByUnit = new Map<number, AffectedEvent[]>();
  for (const booking of bookings) {
    const info = infoById.get(booking.event_id);
    const window = info ? occupiedWindow(info) : null;
    // An event that is over has nothing left to arrange; one that doesn't touch the period is unaffected.
    if (!info || !window || window.endMs < now || !overlaps(window, period)) continue;

    const list = eventsByUnit.get(booking.equipment_id) ?? [];
    if (list.some((e) => e.eventId === info.id)) continue;
    list.push({
      eventId: info.id,
      eventName: info.name || `Event #${info.id}`,
      proposedDate: info.proposedDate,
      startTime: info.startTime,
      coordinatorId: info.coordinatorId ?? null,
    });
    eventsByUnit.set(booking.equipment_id, list);
  }

  return {
    eventsOk,
    units: units.map((unit): ImpactUnit => {
      if (unit.status !== "Available") return { id: unit.id, label: unit.label, state: "unavailable", reason: unit.status, events: [] };
      const out = outOfUse.get(unit.id);
      if (out) return { id: unit.id, label: unit.label, state: "unavailable", reason: out.reason, events: [] };
      const events = eventsByUnit.get(unit.id) ?? [];
      return { id: unit.id, label: unit.label, state: events.length > 0 ? "reserved" : "free", reason: null, events };
    }),
  };
}

/**
 * The units to suggest for `quantity`: free ones first, then — only if there
 * aren't enough — reserved ones, taking those whose soonest event is furthest
 * away first, so those coordinators have the most time to arrange a
 * replacement. Units already out of use are never suggested.
 */
export function suggestUnits(units: ImpactUnit[], quantity: number): number[] {
  const free = units.filter((u) => u.state === "free").sort((a, b) => a.id - b.id);
  const reserved = units
    .filter((u) => u.state === "reserved")
    .sort((a, b) => {
      const soonestA = a.events.map(startKey).sort()[0];
      const soonestB = b.events.map(startKey).sort()[0];
      // Stryker disable next-line EqualityOperator: `<=` only differs for equal keys, which the `===` branch has already handled
      return soonestA === soonestB ? a.id - b.id : soonestA < soonestB ? 1 : -1;
    });
  return [...free, ...reserved].slice(0, quantity).map((u) => u.id);
}
