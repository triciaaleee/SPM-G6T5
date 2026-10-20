/**
 * E5-5: the "available" number Technical Support and coordinators see for an
 * equipment type.
 *
 * equipment_catalog.available_stock is a counter that request statuses move as
 * equipment is reserved and released (migration 0022). It knows nothing about
 * dates, so units marked damaged or under maintenance never lowered it. The
 * number shown is that counter minus the units that are out of use *today*,
 * worked out every time it is read rather than stored — so a unit comes back the
 * day after its period ends, and a period that hasn't started yet doesn't count
 * yet, with nothing to schedule or sweep (the same "applied when checked" stance
 * AGENTS.md §3a takes for expiring holds).
 *
 * A unit out of use that a request already holds (it has an equipment_booking
 * row tied to a request item) is not subtracted again: reserving it already took
 * it out of the counter. A booking with no request item (the old seed rows) was
 * never counted, so it doesn't make a unit "held".
 * A unit set to Damaged or Under Maintenance by status, with no dates, is out of
 * use today for as long as it stays that way.
 */

/** The batch size for `.in(...)` lookups, so a long id list can't overflow the request URL. */
const ID_BATCH = 300;

/** Today's calendar date in Singapore (UTC+8), YYYY-MM-DD — the same reading events use. */
export function todaySingapore(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function inBatches<T>(ids: number[], load: (batch: number[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) out.push(...(await load(ids.slice(i, i + ID_BATCH))));
  return out;
}

/**
 * How many units of each type are out of use today and not already held by a
 * request. Types with none are absent from the map. Throws if a table can't be
 * read.
 */
export async function unusableNowByType(supabase: any, today: string = todaySingapore()): Promise<Map<string, number>> {
  // Units whose own status says unusable, and units with a period running today.
  const { data: statusRows, error: statusError } = await supabase.from("equipment").select("id, type").neq("status", "Available");
  if (statusError) throw new Error("Failed to load equipment");

  const { data: runningRows, error: runningError } = await supabase
    .from("equipment_unavailability")
    .select("equipment_id")
    .lte("start_date", today)
    .or(`end_date.is.null,end_date.gte.${today}`);
  if (runningError) throw new Error("Failed to load equipment unavailability");

  const typeById = new Map<number, string>((statusRows ?? []).map((row: { id: number; type: string }) => [row.id, row.type]));
  const runningIds = [...new Set<number>((runningRows ?? []).map((row: { equipment_id: number }) => row.equipment_id))].filter(
    (id) => !typeById.has(id),
  );
  const runningUnits = await inBatches(runningIds, async (batch) => {
    const { data, error } = await supabase.from("equipment").select("id, type").in("id", batch);
    if (error) throw new Error("Failed to load equipment");
    return (data ?? []) as { id: number; type: string }[];
  });
  for (const unit of runningUnits) typeById.set(unit.id, unit.type);

  const candidateIds = [...typeById.keys()];
  const heldRows = await inBatches(candidateIds, async (batch) => {
    const { data, error } = await supabase
      .from("equipment_booking")
      .select("equipment_id")
      .in("equipment_id", batch)
      .not("request_item_id", "is", null);
    if (error) throw new Error("Failed to load equipment bookings");
    return (data ?? []) as { equipment_id: number }[];
  });
  const held = new Set(heldRows.map((row) => row.equipment_id));

  const counts = new Map<string, number>();
  for (const [id, type] of typeById) {
    if (held.has(id)) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return counts;
}

/** The counter minus what is out of use today, never below zero. */
export function effectiveAvailable(storedAvailable: number, unusableNow: number): number {
  return Math.max(0, storedAvailable - unusableNow);
}
