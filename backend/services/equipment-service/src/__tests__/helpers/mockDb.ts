import type { FakeDb } from "./fakeDb.js";

/**
 * Lets a suite run the REAL auth middleware and routers against a fake
 * database: the suite mocks `../lib/supabaseAdmin.js` with `supabaseAdminProxy`
 * (the factory has to `await import` this file, since vi.mock is hoisted), and
 * each test points the proxy at its own `createFakeDb(...)` with `useDb`.
 */
let current: FakeDb | undefined;

export function useDb<T extends FakeDb>(db: T): T {
  current = db;
  return db;
}

export const supabaseAdminProxy = {
  from: (table: string) => current!.from(table),
  rpc: (fn: string, args?: unknown) => current!.rpc(fn, args),
};
