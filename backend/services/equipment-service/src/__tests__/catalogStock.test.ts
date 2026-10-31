import { describe, expect, it } from "vitest";
import { catalogStockNow, stockOf, todaySingapore } from "../lib/catalogStock.js";
import { createFakeDb } from "./helpers/fakeDb.js";

describe("todaySingapore", () => {
  it("reads the date in UTC+8", () => {
    expect(todaySingapore(new Date("2026-10-28T15:59:59.000Z"))).toBe("2026-10-28");
    expect(todaySingapore(new Date("2026-10-28T16:00:00.000Z"))).toBe("2026-10-29");
  });

  it("defaults to now (the suite's fixed clock)", () => {
    expect(todaySingapore()).toBe("2026-10-28");
  });
});

describe("catalogStockNow", () => {
  it("asks the database for today's window and maps rows by catalog id", async () => {
    const db = createFakeDb();
    db.onRpc("catalog_stock_now", () => ({
      data: [
        { catalog_id: 1, total: 5, unusable_now: 1, available: 3 },
        { catalog_id: 2, total: 0, unusable_now: 0, available: 0 },
      ],
      error: null,
    }));

    const stock = await catalogStockNow(db, "2026-10-28");

    expect(db.rpcCalls).toEqual([
      {
        fn: "catalog_stock_now",
        args: {
          p_day: "2026-10-28",
          p_start_ms: Date.parse("2026-10-28T00:00:00.000Z"),
          p_end_ms: Date.parse("2026-10-29T00:00:00.000Z"),
        },
      },
    ]);
    expect(stock.get(1)).toEqual({ total: 5, unusableNow: 1, available: 3 });
    expect(stock.get(2)).toEqual({ total: 0, unusableNow: 0, available: 0 });
    expect(stock.size).toBe(2);
  });

  it("defaults to today in Singapore", async () => {
    const db = createFakeDb();
    await catalogStockNow(db);
    expect(db.rpcCalls[0].args.p_day).toBe("2026-10-28");
  });

  it("is empty when the database returns no data", async () => {
    const db = createFakeDb();
    expect((await catalogStockNow(db, "2026-10-28")).size).toBe(0);
  });

  it("throws when the stock can't be read", async () => {
    const db = createFakeDb();
    db.onRpc("catalog_stock_now", () => ({ data: null, error: { message: "boom" } }));
    await expect(catalogStockNow(db, "2026-10-28")).rejects.toThrow("Failed to load equipment stock");
  });
});

describe("stockOf", () => {
  it("returns the item's stock, or zeroes when it has none", () => {
    const stock = new Map([[1, { total: 4, unusableNow: 1, available: 2 }]]);
    expect(stockOf(stock, 1)).toEqual({ total: 4, unusableNow: 1, available: 2 });
    expect(stockOf(stock, 9)).toEqual({ total: 0, unusableNow: 0, available: 0 });
  });
});
