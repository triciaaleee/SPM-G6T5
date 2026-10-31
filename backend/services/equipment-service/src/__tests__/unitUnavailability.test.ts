import { describe, expect, it } from "vitest";
import {
  fetchUnavailability,
  overlappingPeriods,
  periodWindow,
  unusableUnitsInWindow,
  type UnavailabilityRow,
} from "../lib/unitUnavailability.js";
import { createFakeDb } from "./helpers/fakeDb.js";

const day = (date: string) => Date.parse(`${date}T00:00:00.000Z`);
const period = (over: Partial<UnavailabilityRow>): UnavailabilityRow => ({
  id: 1,
  equipment_id: 10,
  reason: "Damaged",
  start_date: "2026-11-01",
  end_date: "2026-11-03",
  note: null,
  ...over,
});
const nov2 = { startMs: day("2026-11-02"), endMs: day("2026-11-02") + 3_600_000 };

describe("fetchUnavailability", () => {
  it("does not query for no units", async () => {
    const db = createFakeDb();
    expect(await fetchUnavailability(db, [])).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it("returns only the periods of the given units", async () => {
    const db = createFakeDb({
      equipment_unavailability: [period({ id: 1, equipment_id: 10 }), period({ id: 2, equipment_id: 11 }), period({ id: 3, equipment_id: 12 })],
    });
    const rows = await fetchUnavailability(db, [10, 12]);
    expect(rows.map((r) => r.id).sort()).toEqual([1, 3]);
    expect(db.calls[0].columns).toBe("id, equipment_id, reason, start_date, end_date, note");
  });

  it("throws when the table can't be read", async () => {
    const db = createFakeDb();
    db.failOn("equipment_unavailability", "select");
    await expect(fetchUnavailability(db, [10])).rejects.toThrow("Failed to load equipment unavailability");
  });

  it("treats a null result as no periods", async () => {
    const db = createFakeDb();
    db.nullOn("equipment_unavailability", "select");
    expect(await fetchUnavailability(db, [10])).toEqual([]);
  });
});

describe("periodWindow", () => {
  it("covers the period's days, or is null for a bad date", () => {
    expect(periodWindow({ start_date: "2026-11-01", end_date: "2026-11-01" })).toEqual({ startMs: day("2026-11-01"), endMs: day("2026-11-02") });
    expect(periodWindow({ start_date: "bad", end_date: null })).toBeNull();
  });
});

describe("overlappingPeriods", () => {
  it("maps each unit to its first overlapping period", () => {
    const first = period({ id: 1, reason: "Damaged" });
    const second = period({ id: 2, reason: "Under Maintenance" });
    const map = overlappingPeriods([first, second], nov2);
    expect(map.size).toBe(1);
    expect(map.get(10)).toBe(first);
  });

  it("skips a period that does not overlap, and keeps looking for the unit", () => {
    const early = period({ id: 1, start_date: "2026-10-01", end_date: "2026-10-05" });
    const late = period({ id: 2, reason: "Under Maintenance" });
    expect(overlappingPeriods([early], nov2).size).toBe(0);
    expect(overlappingPeriods([early, late], nov2).get(10)).toBe(late);
  });

  it("treats an unreadable period as overlapping", () => {
    const bad = period({ id: 1, start_date: "garbage" });
    expect(overlappingPeriods([bad], nov2).get(10)).toBe(bad);
  });

  it("does not overlap when the period ends the day before", () => {
    const ends = period({ start_date: "2026-10-30", end_date: "2026-11-01" });
    expect(overlappingPeriods([ends], nov2).size).toBe(0);
  });

  it("tracks units separately", () => {
    const map = overlappingPeriods([period({ id: 1, equipment_id: 10 }), period({ id: 2, equipment_id: 11 })], nov2);
    expect([...map.keys()].sort()).toEqual([10, 11]);
  });
});

describe("unusableUnitsInWindow", () => {
  it("returns the ids unusable in the window", async () => {
    const db = createFakeDb({
      equipment_unavailability: [
        period({ id: 1, equipment_id: 10 }),
        period({ id: 2, equipment_id: 11, start_date: "2026-12-01", end_date: "2026-12-02" }),
      ],
    });
    expect([...(await unusableUnitsInWindow(db, [10, 11], nov2))]).toEqual([10]);
  });
});
