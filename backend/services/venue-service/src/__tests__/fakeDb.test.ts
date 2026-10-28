import { describe, expect, it } from "vitest";
import { createFakeDb } from "./helpers/fakeDb.js";

/** The fake underpins the other suites, so it has to be right itself. */
describe("fakeDb", () => {
  const seed = () => createFakeDb({ t: [{ id: 1, n: "b", s: "x" }, { id: 2, n: "a", s: "y" }, { id: 3, n: "c", s: "x" }] });

  it("filters with every operator", async () => {
    const db = seed();
    expect((await db.from("t").select("*").eq("s", "x")).data.map((r: any) => r.id)).toEqual([1, 3]);
    expect((await db.from("t").select("*").in("id", [2, 3])).data).toHaveLength(2);
    expect((await db.from("t").select("*").lt("id", 2)).data).toHaveLength(1);
    expect((await db.from("t").select("*").lte("id", 2)).data).toHaveLength(2);
    expect((await db.from("t").select("*").gt("id", 2)).data).toHaveLength(1);
    expect((await db.from("t").select("*").gte("id", 2)).data).toHaveLength(2);
    expect((await db.from("t").select("*").is("zz", null)).data).toHaveLength(3);
  });

  it("orders ascending and descending", async () => {
    const db = seed();
    expect((await db.from("t").select("*").order("n")).data.map((r: any) => r.n)).toEqual(["a", "b", "c"]);
    expect((await db.from("t").select("*").order("n", { ascending: false })).data.map((r: any) => r.n)).toEqual(["c", "b", "a"]);
  });

  it("single / maybeSingle behave like PostgREST", async () => {
    const db = seed();
    expect((await db.from("t").select("*").eq("id", 1).single()).data.id).toBe(1);
    expect((await db.from("t").select("*").eq("id", 99).single()).error).toBeTruthy();
    expect((await db.from("t").select("*").eq("id", 99).maybeSingle())).toEqual({ data: null, error: null });
    expect((await db.from("t").select("*").maybeSingle()).error).toBeTruthy();
  });

  it("insert assigns ids and only returns rows when select() follows", async () => {
    const db = seed();
    expect(await db.from("t").insert({ n: "d" })).toEqual({ data: null, error: null });
    const r = await db.from("t").insert({ n: "e" }).select("*").single();
    expect(r.data).toMatchObject({ id: 5, n: "e" });
    expect(db.rows("t")).toHaveLength(5);
  });

  it("update changes matching rows only and returns them on select()", async () => {
    const db = seed();
    const r = await db.from("t").update({ s: "z" }).eq("s", "x").select("*");
    expect(r.data.map((x: any) => x.id)).toEqual([1, 3]);
    expect(db.rows("t").map((x) => x.s)).toEqual(["z", "y", "z"]);
    expect((await db.from("t").update({ s: "q" }).eq("id", 99).select("*")).data).toEqual([]);
  });

  it("delete removes matching rows", async () => {
    const db = seed();
    const r = await db.from("t").delete().eq("id", 2).select("id");
    expect(r.data).toEqual([{ id: 2 }]);
    expect(db.rows("t").map((x) => x.id)).toEqual([1, 3]);
  });

  it("failOn injects errors for the next N matching calls only, leaving data untouched", async () => {
    const db = seed();
    db.failOn("t", "update", 1);
    expect((await db.from("t").update({ s: "z" }).eq("id", 1)).error).toBeTruthy();
    expect(db.rows("t")[0].s).toBe("x");
    expect((await db.from("t").update({ s: "z" }).eq("id", 1)).error).toBeNull();
    expect(db.rows("t")[0].s).toBe("z");
    db.failOn("t", "select", -1, (c) => c.filters.some((f) => f.col === "id" && f.value === 3));
    expect((await db.from("t").select("*").eq("id", 3)).error).toBeTruthy();
    expect((await db.from("t").select("*").eq("id", 2)).error).toBeNull();
    db.clearFailures();
    expect((await db.from("t").select("*").eq("id", 3)).error).toBeNull();
  });

  it("nullOn resolves an empty result; mapOn rewrites the real one but the write still happens", async () => {
    const db = seed();
    db.nullOn("t", "select", 1);
    expect(await db.from("t").select("*")).toEqual({ data: null, error: null });
    expect((await db.from("t").select("*")).data).toHaveLength(3);
    db.mapOn("t", "update", (r) => ({ ...r, data: r.data.map((x: any) => ({ ...x, s: "mapped" })) }), 1);
    const r = await db.from("t").update({ s: "z" }).eq("id", 1).select("*");
    expect(r.data[0].s).toBe("mapped");
    expect(db.rows("t")[0].s).toBe("z");
  });

  it("projects plain column lists but returns whole rows for '*' and embedded joins", async () => {
    const db = seed();
    expect((await db.from("t").select("id, n").eq("id", 1)).data).toEqual([{ id: 1, n: "b" }]);
    expect((await db.from("t").select("*").eq("id", 1)).data).toEqual([{ id: 1, n: "b", s: "x" }]);
    expect((await db.from("t").select("id, other (name)").eq("id", 1)).data).toEqual([{ id: 1, n: "b", s: "x" }]);
    expect((await db.from("t").select("id, nope").eq("id", 1).single()).data).toEqual({ id: 1 });
    expect((await db.from("t").update({ s: "q" }).eq("id", 1).select("id")).data).toEqual([{ id: 1 }]);
  });

  it("records calls and writes", async () => {
    const db = seed();
    await db.from("t").select("*");
    await db.from("t").update({ s: "k" }).eq("id", 1);
    expect(db.calls).toHaveLength(2);
    expect(db.writes("t")).toHaveLength(1);
    expect(db.writes("t")[0]).toMatchObject({ op: "update", payload: { s: "k" } });
  });

  it("places NULLs like Postgres: last when ascending, first when descending, unless nullsFirst says otherwise", async () => {
    const db = createFakeDb({ t: [{ id: 1, v: "b" }, { id: 2, v: null }, { id: 3, v: "a" }, { id: 4 }] });
    const ids = async (o?: { ascending?: boolean; nullsFirst?: boolean }) =>
      (await db.from("t").select("*").order("v", o)).data.map((r: { id: number }) => r.id);
    expect(await ids()).toEqual([3, 1, 2, 4]);
    expect(await ids({ nullsFirst: true })).toEqual([2, 4, 3, 1]);
    expect(await ids({ nullsFirst: false })).toEqual([3, 1, 2, 4]);
    expect(await ids({ ascending: false })).toEqual([2, 4, 1, 3]);
    expect(await ids({ ascending: false, nullsFirst: false })).toEqual([1, 3, 2, 4]);
  });

  /**
   * The cases below are what src/__tests__/integration/fakeDbContract.test.ts
   * found by running the same queries against the real database.
   */
  describe("answers like Postgres/PostgREST", () => {
    const ids = async (query: PromiseLike<{ data: any }>) => (await query).data.map((r: { id: number }) => r.id);

    it("eq and in never match NULL, and eq(column, null) matches nothing", async () => {
      const db = createFakeDb({ t: [{ id: 1, v: "a" }, { id: 2, v: null }, { id: 3 }] });
      expect(await ids(db.from("t").select("*").eq("v", null))).toEqual([]);
      expect(await ids(db.from("t").select("*").in("v", [null, "a"]))).toEqual([1]);
      expect(await ids(db.from("t").select("*").is("v", null))).toEqual([2, 3]);
    });

    it("comparisons leave NULL rows out, even against a value that coerces to 0", async () => {
      const db = createFakeDb({ t: [{ id: 1, n: 5 }, { id: 2, n: null }, { id: 3 }, { id: 4, n: -1 }] });
      expect(await ids(db.from("t").select("*").lt("n", 10))).toEqual([1, 4]);
      expect(await ids(db.from("t").select("*").lte("n", 5))).toEqual([1, 4]);
      expect(await ids(db.from("t").select("*").gt("n", -5))).toEqual([1, 4]);
      expect(await ids(db.from("t").select("*").gte("n", 5))).toEqual([1]);
      expect(await ids(db.from("t").select("*").lt("n", null))).toEqual([]);
    });

    it("casts a numeric string filter value to a number column and back", async () => {
      const db = createFakeDb({ t: [{ id: 1, code: "7" }, { id: 2, code: "8" }] });
      expect(await ids(db.from("t").select("*").eq("id", "2"))).toEqual([2]);
      expect(await ids(db.from("t").select("*").in("id", ["1", "2"]))).toEqual([1, 2]);
      expect(await ids(db.from("t").select("*").eq("code", 7))).toEqual([1]);
      expect(await ids(db.from("t").select("*").gt("id", "1"))).toEqual([2]);
      expect(await ids(db.from("t").select("*").eq("id", "1x"))).toEqual([]);
      expect(await ids(db.from("t").select("*").eq("id", " "))).toEqual([]);
    });

    it("compares times by value, so 09:00 equals 09:00:00", async () => {
      const db = createFakeDb({ t: [{ id: 1, at: "09:00:00" }, { id: 2, at: "13:00:00" }, { id: 3, at: "14:00:00" }] });
      expect(await ids(db.from("t").select("*").eq("at", "09:00"))).toEqual([1]);
      expect(await ids(db.from("t").select("*").gt("at", "09:00"))).toEqual([2, 3]);
      expect(await ids(db.from("t").select("*").lte("at", "13:00"))).toEqual([1, 2]);
      expect(await ids(db.from("t").select("*").gte("at", "13:00:00"))).toEqual([2, 3]);
    });

    it("compares timestamps as instants, however the offset is written", async () => {
      const db = createFakeDb({ t: [{ id: 1, at: "2026-11-01T10:00:00+00:00" }, { id: 2, at: "2026-11-01T12:00:00.500+00:00" }] });
      expect(await ids(db.from("t").select("*").eq("at", "2026-11-01T10:00:00Z"))).toEqual([1]);
      expect(await ids(db.from("t").select("*").gt("at", "2026-11-01T10:00:00Z"))).toEqual([2]);
      expect(await ids(db.from("t").select("*").lt("at", "2026-11-01T19:00:00+08:00"))).toEqual([1]); // 11:00Z
      expect(await ids(db.from("t").select("*").lt("at", "2026-11-01T18:00:00+08:00"))).toEqual([]); // 10:00Z, not before itself
    });

    it("orders text by the database collation, not by code point", async () => {
      const names = ["apple", "Banana", "cherry", "Apple 2", "9 hall", "10 hall", "hall-a", "hall b", "Hall B2", "hallc", "_under", "zed", "Zed"];
      const db = createFakeDb({ t: names.map((n, i) => ({ id: i + 1, n })) });
      const order = async (o?: { ascending?: boolean }) => (await db.from("t").select("*").order("n", o)).data.map((r: { n: string }) => r.n);
      // What the real database returned for these exact names (see the contract test).
      const real = ["_under", "10 hall", "9 hall", "apple", "Apple 2", "Banana", "cherry", "hall b", "Hall B2", "hall-a", "hallc", "zed", "Zed"];
      expect(await order()).toEqual(real);
      expect(await order({ ascending: false })).toEqual([...real].reverse());
    });
  });
  describe("unique keys", () => {
    const locks = (rows: any[] = []) => createFakeDb({ l: rows }, { unique: { l: ["venue_id"] } });

    it("rejects a repeated key with 23505 and stores nothing", async () => {
      const db = locks([{ venue_id: 1 }]);
      const dup = await db.from("l").insert({ venue_id: 1 });
      expect(dup.error).toMatchObject({ code: "23505" });
      expect(db.rows("l")).toHaveLength(1);
    });

    it("accepts a new key, and a key in a table with no rule", async () => {
      const db = locks([{ venue_id: 1 }]);
      expect((await db.from("l").insert({ venue_id: 2 })).error).toBeNull();
      expect((await db.from("other").insert({ venue_id: 1 })).error).toBeNull();
      expect((await db.from("other").insert({ venue_id: 1 })).error).toBeNull();
      expect(db.rows("l")).toHaveLength(2);
    });

    it("rejects a whole batch if any row repeats a key, including a repeat inside the batch", async () => {
      const db = locks([{ venue_id: 1 }]);
      expect((await db.from("l").insert([{ venue_id: 5 }, { venue_id: 1 }])).error).toMatchObject({ code: "23505" });
      expect((await db.from("l").insert([{ venue_id: 6 }, { venue_id: 6 }])).error).toMatchObject({ code: "23505" });
      expect(db.rows("l")).toHaveLength(1);
    });

    it("lets the key be taken again after the row is deleted", async () => {
      const db = locks([{ venue_id: 1 }]);
      await db.from("l").delete().eq("venue_id", 1);
      expect((await db.from("l").insert({ venue_id: 1 })).error).toBeNull();
    });

    it("treats 1 and \"1\" as the same key, as PostgREST casts to the column type", async () => {
      const db = locks([{ venue_id: 1 }]);
      expect((await db.from("l").insert({ venue_id: "1" })).error).toMatchObject({ code: "23505" });
    });

    it("never treats NULL keys as equal to each other (unique allows several NULLs)", async () => {
      const db = locks([{ venue_id: null }]);
      expect((await db.from("l").insert({ venue_id: null })).error).toBeNull();
    });
  });
});
