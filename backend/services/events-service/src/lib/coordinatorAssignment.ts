import type { supabaseAdmin } from "./supabaseAdmin.js";

/**
 * E2-6: auto-assign a coordinator to a newly submitted event, round-robin.
 *
 * "Active coordinator" = any user with role = 'coordinator'. There's no
 * capacity/active-status model anywhere in the schema, and the PRD's own
 * open question (Q5) says the customer didn't specify one — team decision
 * was to keep it this simple until a real requirement shows up.
 *
 * Rotation state isn't stored separately: it's derived from the events
 * table's own history (who got the last auto-assignment), ordered by
 * coordinator id for a stable rotation order. No locking — two events
 * submitted at the exact same instant could race and compute the same
 * "next" coordinator. Acceptable at this project's scale; not solved here.
 */
export async function assignCoordinator(
  supabase: typeof supabaseAdmin,
): Promise<string | null> {
  const { data: coordinators, error: coordinatorsError } = await supabase
    .from("users")
    .select("id")
    .eq("role", "coordinator")
    .order("id", { ascending: true });

  if (coordinatorsError || !coordinators || coordinators.length === 0) {
    return null;
  }

  const ids = coordinators.map((c) => c.id as string);

  const { data: lastAssigned } = await supabase
    .from("events")
    .select("coordinator_id")
    .not("coordinator_id", "is", null)
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();

  const lastIndex = lastAssigned ? ids.indexOf(lastAssigned.coordinator_id as string) : -1;
  const nextIndex = (lastIndex + 1) % ids.length;

  return ids[nextIndex];
}
