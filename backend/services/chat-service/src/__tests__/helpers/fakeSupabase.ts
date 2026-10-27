import { vi } from "vitest";

/**
 * An in-memory stand-in for the slice of supabase-js that chat-service uses on
 * `chat_messages`. Unlike a canned result, it actually applies eq / neq / is /
 * in / lt, ordering, limit and head-counts to the rows it holds, so a test that
 * gets a filter wrong sees different data (and mutation testing can tell).
 */
export type Row = Record<string, any>;
type DbError = { message: string } | null;

export interface FakeSupabaseOptions {
  messages?: Row[];
  /** Fails only the selects this returns an error for (e.g. just the unread count). */
  selectErrorWhen?: (query: { columns: string; head: boolean; limit: number | null }) => DbError;
  /** Makes every select fail with this error. */
  selectError?: DbError;
  /** Result of insert(...).select(...).single(). */
  insertResult?: { data: unknown; error: DbError };
  updateError?: DbError;
  /** Selects succeed but hand back data:null / count:null (supabase-js can do this). */
  nullData?: boolean;
}

export function createFakeSupabase(options: FakeSupabaseOptions = {}) {
  const sel = {
    select: vi.fn(),
    eq: vi.fn(),
    neq: vi.fn(),
    is: vi.fn(),
    in: vi.fn(),
    lt: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
  };
  const upd = { update: vi.fn(), eq: vi.fn(), neq: vi.fn(), is: vi.fn() };
  const insert = vi.fn();

  function selectQuery() {
    const filters: ((row: Row) => boolean)[] = [];
    let orderBy: { column: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    let head = false;
    let columns = "*";
    const q: Record<string, any> = {};

    q.select = (cols?: string, opts?: { head?: boolean }) => {
      sel.select(cols, opts);
      columns = cols ?? "*";
      head = opts?.head === true;
      return q;
    };
    q.eq = (c: string, v: unknown) => (sel.eq(c, v), filters.push((r) => r[c] === v), q);
    q.neq = (c: string, v: unknown) => (sel.neq(c, v), filters.push((r) => r[c] !== v), q);
    q.is = (c: string, v: unknown) => (sel.is(c, v), filters.push((r) => (r[c] ?? null) === v), q);
    q.in = (c: string, vs: unknown[]) => (sel.in(c, vs), filters.push((r) => vs.includes(r[c])), q);
    q.lt = (c: string, v: number) => (sel.lt(c, v), filters.push((r) => r[c] < v), q);
    q.order = (column: string, o?: { ascending?: boolean }) => {
      sel.order(column, o);
      orderBy = { column, ascending: o?.ascending !== false };
      return q;
    };
    q.limit = (n: number) => (sel.limit(n), (limit = n), q);
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      const error = options.selectError ?? options.selectErrorWhen?.({ columns, head, limit }) ?? null;
      if (error) {
        return Promise.resolve({ data: null, error, count: null }).then(resolve, reject);
      }
      if (options.nullData) return Promise.resolve({ data: null, error: null, count: null }).then(resolve, reject);
      let rows = (options.messages ?? []).filter((r) => filters.every((f) => f(r)));
      const count = rows.length;
      if (orderBy) {
        const { column, ascending } = orderBy;
        rows = [...rows].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1));
      }
      if (limit !== null) rows = rows.slice(0, limit);
      const data = head
        ? null
        : columns === "*" || columns.includes(",")
          ? rows
          : rows.map((r) => ({ [columns]: r[columns] }));
      return Promise.resolve({ data, error: null, count }).then(resolve, reject);
    };
    return q;
  }

  function updateQuery() {
    const q: Record<string, any> = {};
    q.eq = (c: string, v: unknown) => (upd.eq(c, v), q);
    q.neq = (c: string, v: unknown) => (upd.neq(c, v), q);
    q.is = (c: string, v: unknown) => (upd.is(c, v), q);
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: options.updateError ?? null }).then(resolve, reject);
    return q;
  }

  const supabase = {
    from: vi.fn((table: string) => {
      if (table !== "chat_messages") throw new Error(`unexpected table ${table}`);
      return {
        select: (...args: unknown[]) => (selectQuery() as any).select(...args),
        update: (patch: unknown) => (upd.update(patch), updateQuery()),
        insert: (row: unknown) => {
          insert(row);
          const result = options.insertResult ?? { data: null, error: null };
          const q: Record<string, any> = {};
          q.select = () => q;
          q.single = () => Promise.resolve(result);
          return q;
        },
      };
    }),
  };

  return { supabase, sel, upd, insert };
}
