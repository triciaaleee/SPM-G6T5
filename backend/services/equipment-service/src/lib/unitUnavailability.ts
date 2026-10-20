/**
 * E5-5: reads equipment_unavailability (migration 0043) — the periods
 * Technical Support mark a unit damaged or under maintenance. Shared by the
 * availability check (E5-4), the reservation claim (E5-6), the reservation
 * flags and the units routes.
 */

import { dateRangeWindow, overlaps, type OccupiedWindow } from "./scheduleWindow.js";

export const UNAVAILABILITY_REASONS = ["Damaged", "Under Maintenance"] as const;
export type UnavailabilityReason = (typeof UNAVAILABILITY_REASONS)[number];

export interface UnavailabilityRow {
  id: number;
  equipment_id: number;
  reason: UnavailabilityReason;
  start_date: string;
  end_date: string | null;
  note: string | null;
}

export const UNAVAILABILITY_COLUMNS = "id, equipment_id, reason, start_date, end_date, note";

/** Every period for the given units. Throws if the table can't be read. */
export async function fetchUnavailability(supabase: any, equipmentIds: number[]): Promise<UnavailabilityRow[]> {
  if (equipmentIds.length === 0) return [];
  const { data, error } = await supabase
    .from("equipment_unavailability")
    .select(UNAVAILABILITY_COLUMNS)
    .in("equipment_id", equipmentIds);
  if (error) throw new Error("Failed to load equipment unavailability");
  return (data ?? []) as UnavailabilityRow[];
}

/** The window a period covers, or null for a malformed date. */
export function periodWindow(period: Pick<UnavailabilityRow, "start_date" | "end_date">): OccupiedWindow | null {
  return dateRangeWindow(period.start_date, period.end_date);
}

/**
 * Which units have a period overlapping `window`, mapped to the first such
 * period (for the reason shown to the coordinator). A period whose dates
 * can't be read is treated as overlapping rather than over-promising the unit.
 */
export function overlappingPeriods(rows: UnavailabilityRow[], window: OccupiedWindow): Map<number, UnavailabilityRow> {
  const byUnit = new Map<number, UnavailabilityRow>();
  for (const row of rows) {
    if (byUnit.has(row.equipment_id)) continue;
    const covered = periodWindow(row);
    if (!covered || overlaps(window, covered)) byUnit.set(row.equipment_id, row);
  }
  return byUnit;
}

/** The ids of `unitIds` that are unusable at some point in `window`. */
export async function unusableUnitsInWindow(supabase: any, unitIds: number[], window: OccupiedWindow): Promise<Set<number>> {
  const rows = await fetchUnavailability(supabase, unitIds);
  return new Set(overlappingPeriods(rows, window).keys());
}
