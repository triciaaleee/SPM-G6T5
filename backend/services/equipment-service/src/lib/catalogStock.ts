import { dateRangeWindow } from "./scheduleWindow.js";

/**
 * The stock numbers Technical Support and coordinators see for each equipment
 * item, worked out from the unit rows every time they are read (migration 0051,
 * `catalog_stock_now`) rather than from a stored counter.
 *
 *   total      the units of the item, whatever their condition
 *   unusable   units out of use today: status Damaged / Under Maintenance, or a
 *              period (E5-5) running today
 *   available  usable units with no booking whose window overlaps today
 *
 * A unit marked unusable comes back the day after its period ends, and a unit
 * booked for a later date still counts as available today, with nothing to
 * schedule or sweep (the same "applied when checked" stance AGENTS.md §3a takes
 * for expiring holds). Bookings made before migration 0050 have no stored window
 * and are not counted as booked.
 */
export interface CatalogStock {
  total: number;
  unusableNow: number;
  available: number;
}

/** Today's calendar date in Singapore (UTC+8), YYYY-MM-DD — the same reading events use. */
export function todaySingapore(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** Stock for every catalog item, keyed by catalog id. Throws if it can't be read. */
export async function catalogStockNow(supabase: any, today: string = todaySingapore()): Promise<Map<number, CatalogStock>> {
  const day = dateRangeWindow(today, today)!;
  const { data, error } = await supabase.rpc("catalog_stock_now", {
    p_day: today,
    p_start_ms: day.startMs,
    p_end_ms: day.endMs,
  });
  if (error) throw new Error("Failed to load equipment stock");

  const stock = new Map<number, CatalogStock>();
  for (const row of (data ?? []) as { catalog_id: number; total: number; unusable_now: number; available: number }[]) {
    stock.set(row.catalog_id, { total: row.total, unusableNow: row.unusable_now, available: row.available });
  }
  return stock;
}

const NO_STOCK: CatalogStock = { total: 0, unusableNow: 0, available: 0 };

export function stockOf(stock: Map<number, CatalogStock>, catalogId: number): CatalogStock {
  return stock.get(catalogId) ?? NO_STOCK;
}
