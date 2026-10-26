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
});
