import type { VenueIconName } from "../components/venues/VenueIcon.vue";

/**
 * The five things a block on the venue schedule calendar can be. The legend and
 * the blocks both read this, so a status's name, icon and style class stay in
 * step (Style.md 3.5, `schedule-block-*`).
 */
export type CalendarStatusKey = "approved" | "hold" | "requested" | "replace" | "block";

export interface CalendarStatus {
  key: CalendarStatusKey;
  label: string;
  icon: VenueIconName;
}

export const CALENDAR_STATUSES: CalendarStatus[] = [
  { key: "approved", label: "Approved", icon: "check" },
  { key: "hold", label: "On Hold", icon: "pause" },
  { key: "requested", label: "Requested", icon: "clock" },
  { key: "replace", label: "Replacement Required", icon: "warning" },
  { key: "block", label: "Unavailable", icon: "lock" },
];

/** The booking statuses the calendar shows; anything else reads as Approved, as it always has. */
const BOOKING_STATUS_KEYS: Record<string, CalendarStatusKey> = {
  "On Hold": "hold",
  Requested: "requested",
  "Replacement Required": "replace",
};

export function calendarStatusOf(entry: { kind: "booking" | "block"; status?: string }): CalendarStatus {
  const key: CalendarStatusKey = entry.kind === "block" ? "block" : (BOOKING_STATUS_KEYS[entry.status ?? ""] ?? "approved");
  return CALENDAR_STATUSES.find((s) => s.key === key)!;
}
