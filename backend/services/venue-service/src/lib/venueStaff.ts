/**
 * Which venues a member of venue staff looks after (E4-10 AC7). The
 * venue_staff role alone is not enough to act on a booking: staff decide
 * for their own venues only. A venue carries its owner in `venues.staff_id`
 * (migration 0015), so a venue has at most one assigned staff member and a
 * venue with no staff_id has nobody who can decide on it. There is no UI
 * for maintaining it yet.
 */
import type { AuthedRequest } from "../middleware/auth.js";

type Supabase = NonNullable<AuthedRequest["supabase"]>;

export type AssignedVenuesResult = { status: "ok"; venueIds: number[] } | { status: "error" };

export async function assignedVenueIds(supabase: Supabase, staffId: string): Promise<AssignedVenuesResult> {
  const { data, error } = await supabase.from("venues").select("id").eq("staff_id", staffId);
  if (error) return { status: "error" };
  return { status: "ok", venueIds: ((data ?? []) as { id: number }[]).map((row) => row.id) };
}

export async function isAssignedToVenue(
  supabase: Supabase,
  staffId: string,
  venueId: number,
): Promise<{ status: "ok"; assigned: boolean } | { status: "error" }> {
  const { data, error } = await supabase
    .from("venues")
    .select("id")
    .eq("id", venueId)
    .eq("staff_id", staffId)
    .maybeSingle();
  if (error) return { status: "error" };
  return { status: "ok", assigned: data !== null };
}

/**
 * The 403 for an unassigned venue has to read differently from the role
 * 403 in routes/staff.ts: the caller *is* venue staff, just not this
 * venue's.
 */
export const NOT_ASSIGNED_MESSAGE = "You are not assigned to this venue";
