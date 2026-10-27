import { describe, expect, it, vi } from "vitest";
import { assignedVenueIds, isAssignedToVenue } from "../lib/venueStaff.js";
import { createFakeDb } from "./helpers/fakeDb.js";

/** Chainable supabase stub: every builder method returns itself, the chain resolves to `result`. */
function stub(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => result);
  chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return { from: vi.fn(() => chain), chain };
}

describe("assignedVenueIds", () => {
  it("returns the ids of the venues the staff member looks after", async () => {
    const sb = stub({ data: [{ id: 1 }, { id: 4 }], error: null });
    const r = await assignedVenueIds(sb as never, "VEN-0001");
    expect(r).toEqual({ status: "ok", venueIds: [1, 4] });
    expect(sb.from).toHaveBeenCalledWith("venues");
    expect(sb.chain.eq).toHaveBeenCalledWith("staff_id", "VEN-0001");
  });

  it("returns an empty list when nothing is assigned (null data)", async () => {
    const r = await assignedVenueIds(stub({ data: null, error: null }) as never, "VEN-0002");
    expect(r).toEqual({ status: "ok", venueIds: [] });
  });

  it("reports an error rather than an empty list when the query fails", async () => {
    const r = await assignedVenueIds(stub({ data: null, error: { message: "boom" } }) as never, "VEN-0001");
    expect(r).toEqual({ status: "error" });
  });
});

describe("isAssignedToVenue", () => {
  it("is assigned when a matching venue row exists", async () => {
    const sb = stub({ data: { id: 3 }, error: null });
    expect(await isAssignedToVenue(sb as never, "VEN-0001", 3)).toEqual({ status: "ok", assigned: true });
    expect(sb.chain.eq).toHaveBeenCalledWith("id", 3);
    expect(sb.chain.eq).toHaveBeenCalledWith("staff_id", "VEN-0001");
  });

  it("is not assigned when no row matches", async () => {
    expect(await isAssignedToVenue(stub({ data: null, error: null }) as never, "VEN-0001", 3)).toEqual({
      status: "ok",
      assigned: false,
    });
  });

  it("reports an error when the query fails", async () => {
    expect(await isAssignedToVenue(stub({ data: null, error: { message: "x" } }) as never, "VEN-0001", 3)).toEqual({
      status: "error",
    });
  });
});

describe("isAssignedToVenue asks only for the venue id", () => {
  it("selects just id, and reads assignment from the row existing", async () => {
    const db = createFakeDb({ venues: [{ id: 1, staff_id: "S1", name: "Hall" }] });
    expect(await isAssignedToVenue(db as never, "S1", 1)).toEqual({ status: "ok", assigned: true });
    expect(await isAssignedToVenue(db as never, "S2", 1)).toEqual({ status: "ok", assigned: false });
    expect(db.calls.map((c) => c.columns)).toEqual(["id", "id"]);
  });
});
