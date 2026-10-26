/**
 * An in-memory stand-in for the supabase-js query builder, shared by the
 * edge-case suites. Unlike the per-file stubs it actually stores rows, so a
 * test can assert on the resulting STATE (a booking's new status, a row
 * that was deleted) instead of only on which methods were called — which is
 * what makes the assertions hold up against mutated code.
 *
 * Supported: select/insert/update/delete, eq/in/lt/lte/gt/gte/is filters,
 * order (with `ascending` and `nullsFirst`, NULLs placed as Postgres does),
 * single/maybeSingle, and awaiting the builder. A plain column list
 * passed to `select` ("id, name") projects the rows like PostgREST does, so
 * a query that over-selects is visible in the response. A list containing an
 * embedded join ("event_id, venues (name)") or "*" returns whole rows, so
 * tests pre-embed any joined data (e.g. `venues: { name }`) on the row.
 *
 * Failure injection: `db.failOn("venue_bookings", "update")` makes every
 * such call resolve `{ data: null, error }`; pass a count to fail only the
 * next N calls, or a predicate to fail selectively.
 */
type Row = Record<string, any>;
type Op = "select" | "insert" | "update" | "delete";
type Filter = { col: string; kind: "eq" | "in" | "lt" | "lte" | "gt" | "gte" | "is"; value: any };
export interface Call {
  table: string;
  op: Op;
  filters: Filter[];
  payload?: any;
  /** The column list passed to `.select()`, as written. */
  columns?: string;
}
type Rule = {
  table: string;
  op: Op | "*";
  remaining: number;
  when?: (call: Call) => boolean;
  /** fail: resolve an error; empty: resolve `{ data: null, error: null }`; map: rewrite the real result. */
  kind: "fail" | "empty" | "map";
  map?: (result: { data: any; error: any }) => { data: any; error: any };
};

const ERROR = { message: "injected failure", code: "XX000" };

function matches(row: Row, f: Filter): boolean {
  const v = row[f.col];
  switch (f.kind) {
    case "eq": return v === f.value;
    case "in": return (f.value as any[]).includes(v);
    case "lt": return v < f.value;
    case "lte": return v <= f.value;
    case "gt": return v > f.value;
    case "gte": return v >= f.value;
    case "is": return f.value === null ? v === null || v === undefined : v === f.value;
  }
}

export function createFakeDb(initial: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(initial)) tables[name] = rows.map((r) => ({ ...r }));
  const nextId: Record<string, number> = {};
  const rules: Rule[] = [];
  const calls: Call[] = [];

  const rowsOf = (t: string) => (tables[t] ??= []);

  function matchRule(call: Call): Rule | undefined {
    for (const rule of rules) {
      if (rule.table !== call.table || (rule.op !== "*" && rule.op !== call.op) || rule.remaining === 0) continue;
      if (rule.when && !rule.when(call)) continue;
      if (rule.remaining > 0) rule.remaining -= 1;
      return rule;
    }
    return undefined;
  }

  function from(table: string) {
    let op: Op = "select";
    let payload: any;
    let returning = false;
    const filters: Filter[] = [];
    const orderBy: { col: string; ascending: boolean; nullsFirst: boolean }[] = [];
    let mode: "many" | "single" | "maybe" = "many";
    let columns: string[] | null = null;
    let selected: string | undefined;

    function run(): { data: any; error: any; rule?: Rule } {
      const call: Call = { table, op, filters: [...filters], payload, columns: selected };
      calls.push(call);
      const rule = matchRule(call);
      if (rule?.kind === "fail") return { data: null, error: { ...ERROR } };
      if (rule?.kind === "empty") return { data: null, error: null };

      const matched = () => rowsOf(table).filter((r) => filters.every((f) => matches(r, f)));
      const done = (result: { data: any; error: any }) => (rule?.kind === "map" ? rule.map!(result) : result);
      let out: Row[];
      if (op === "insert") {
        const incoming = Array.isArray(payload) ? payload : [payload];
        out = incoming.map((p: Row) => {
          const row = { ...p };
          if (row.id === undefined) row.id = nextId[table] = (nextId[table] ?? Math.max(0, ...rowsOf(table).map((r) => Number(r.id) || 0))) + 1;
          rowsOf(table).push(row);
          return { ...row };
        });
      } else if (op === "update") {
        out = matched().map((r) => { Object.assign(r, payload); return { ...r }; });
      } else if (op === "delete") {
        const gone = matched();
        tables[table] = rowsOf(table).filter((r) => !gone.includes(r));
        out = gone.map((r) => ({ ...r }));
      } else {
        out = matched().map((r) => ({ ...r }));
      }
      for (const { col, ascending, nullsFirst } of [...orderBy].reverse()) {
        out.sort((a, b) => {
          const aNull = a[col] === null || a[col] === undefined;
          const bNull = b[col] === null || b[col] === undefined;
          // Where NULLs go does not depend on the direction (Postgres: last for ASC, first for DESC, unless told).
          if (aNull || bNull) return aNull && bNull ? 0 : aNull === nullsFirst ? -1 : 1;
          return a[col] === b[col] ? 0 : (a[col] < b[col] ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      if (columns) {
        const cols = columns;
        out = out.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
      }
      // insert/update/delete return rows only when `.select()` followed
      if (op !== "select" && !returning) return done({ data: null, error: null });
      if (mode === "many") return done({ data: out, error: null });
      if (mode === "single") {
        return done(out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: "single row expected", code: "PGRST116" } });
      }
      if (out.length > 1) return done({ data: null, error: { message: "multiple rows", code: "PGRST116" } });
      return done({ data: out[0] ?? null, error: null });
    }
    const execute = () => run();

    const q: any = {
      select(cols?: string) {
        if (op !== "select") returning = true;
        selected = cols;
        if (typeof cols === "string" && cols.trim() !== "*" && !cols.includes("(")) columns = cols.split(",").map((c) => c.trim()).filter(Boolean);
        return q;
      },
      insert(p: any) { op = "insert"; payload = p; return q; },
      update(p: any) { op = "update"; payload = p; return q; },
      delete() { op = "delete"; return q; },
      order(col: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) {
        const ascending = o.ascending !== false;
        orderBy.push({ col, ascending, nullsFirst: o.nullsFirst ?? !ascending });
        return q;
      },
      maybeSingle() { mode = "maybe"; return Promise.resolve().then(execute); },
      single() { mode = "single"; return Promise.resolve().then(execute); },
      then(res: any, rej: any) { return Promise.resolve().then(execute).then(res, rej); },
    };
    for (const kind of ["eq", "in", "lt", "lte", "gt", "gte", "is"] as const) {
      q[kind] = (col: string, value: any) => { filters.push({ col, kind, value }); return q; };
    }
    return q;
  }

  return {
    from,
    tables,
    calls,
    /** Rows currently stored in `table`. */
    rows: (table: string) => rowsOf(table),
    /** Calls that wrote (insert/update/delete) to `table`. */
    writes: (table: string) => calls.filter((c) => c.table === table && c.op !== "select"),
    /** Fail the next `times` matching calls (default: every one from now on). */
    failOn(table: string, op: Op | "*" = "*", times = -1, when?: (call: Call) => boolean) {
      rules.push({ table, op, remaining: times, when, kind: "fail" });
    },
    /** Resolve `{ data: null, error: null }` — what a driver can hand back — for matching calls. */
    nullOn(table: string, op: Op | "*" = "*", times = -1, when?: (call: Call) => boolean) {
      rules.push({ table, op, remaining: times, when, kind: "empty" });
    },
    /** Rewrite the real result of matching calls (the write still happens). */
    mapOn(table: string, op: Op | "*", map: (result: { data: any; error: any }) => { data: any; error: any }, times = -1) {
      rules.push({ table, op, remaining: times, kind: "map", map });
    },
    clearFailures() { rules.length = 0; },
  };
}
export type FakeDb = ReturnType<typeof createFakeDb>;
