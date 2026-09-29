import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";
import { describe, expect, it, vi } from "vitest";
import { authRouter } from "../routes/auth.js";
import { verifyToken } from "../lib/jwt.js";
import { PASSWORD_RULE, PASSWORD_TOO_LONG } from "../lib/passwordPolicy.js";

process.env.JWT_SECRET = "test-only-secret";

// Same indirection as auth.test.ts: vi.mock is hoisted, so each test
// swaps the fake behind globalThis rather than the mock itself.
vi.mock("../lib/supabaseAdmin.js", () => ({
  supabaseAdmin: {
    from: (table: string) => (globalThis as any).__mockSupabase.from(table),
    rpc: (fn: string, args: unknown) => (globalThis as any).__mockSupabase.rpc(fn, args),
  },
}));

const VALID = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  password: "analytical1",
};

type DbError = { message: string; code?: string };

interface FakeOptions {
  /** A row already holding this email (AC2 pre-check). */
  existing?: { id: string } | null;
  lookupError?: DbError | null;
  insertError?: DbError | null;
}

/**
 * Stands in for the `users` table and the generate_user_id RPC. Records
 * every inserted row and every RPC role so tests can assert on what the
 * route actually tried to write.
 */
function buildApp(opts: FakeOptions = {}) {
  const inserts: Record<string, any>[] = [];
  const rpcRoles: string[] = [];
  const prefix: Record<string, string> = { attendee: "ATT", organiser: "ORG" };

  (globalThis as any).__mockSupabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: opts.lookupError ? null : (opts.existing ?? null),
            error: opts.lookupError ?? null,
          }),
        }),
      }),
      insert: (row: Record<string, any>) => {
        inserts.push(row);
        return {
          select: () => ({
            single: async () =>
              opts.insertError
                ? { data: null, error: opts.insertError }
                : {
                    data: { id: row.id, name: row.name, email: row.email, role: row.role },
                    error: null,
                  },
          }),
        };
      },
    }),
    rpc: async (_fn: string, args: { p_role: string }) => {
      rpcRoles.push(args.p_role);
      return { data: `${prefix[args.p_role] ?? "X"}-0001`, error: null };
    },
  };

  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  return { app, inserts, rpcRoles };
}

function signup(app: express.Express, body: Record<string, unknown>) {
  return request(app).post("/api/auth/signup").send(body);
}

describe("POST /api/auth/signup — valid signup (AC1)", () => {
  it("creates the account and returns a working session", async () => {
    const { app, inserts } = buildApp();

    const res = await signup(app, VALID);

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({
      id: "ATT-0001",
      name: "Ada Lovelace",
      email: "ada@example.com",
      role: "attendee",
    });
    expect(verifyToken(res.body.token)).toMatchObject({ sub: "ATT-0001", role: "attendee" });
    expect(inserts).toHaveLength(1);
  });

  it("stores a bcrypt hash that verifies against the chosen password", async () => {
    const { app, inserts } = buildApp();

    await signup(app, VALID);

    const hash = inserts[0].password_hash as string;
    expect(hash).not.toBe(VALID.password);
    expect(await bcrypt.compare(VALID.password, hash)).toBe(true);
  });

  it("never returns the password hash", async () => {
    const { app } = buildApp();

    const res = await signup(app, VALID);

    expect(JSON.stringify(res.body)).not.toContain("$2");
  });

  it("trims the name and trims + lowercases the email", async () => {
    const { app, inserts } = buildApp();

    await signup(app, { ...VALID, name: "  Ada  ", email: "  Ada@Example.COM " });

    expect(inserts[0].name).toBe("Ada");
    expect(inserts[0].email).toBe("ada@example.com");
  });
});

describe("POST /api/auth/signup — role (AC4)", () => {
  it("defaults to attendee when no role is given", async () => {
    const { app, inserts, rpcRoles } = buildApp();

    const res = await signup(app, VALID);

    expect(res.body.user.role).toBe("attendee");
    expect(inserts[0].role).toBe("attendee");
    expect(rpcRoles).toEqual(["attendee"]);
  });

  it("creates an attendee when attendee is chosen", async () => {
    const { app } = buildApp();

    const res = await signup(app, { ...VALID, role: "attendee" });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("attendee");
  });

  it("creates an organiser with an ORG- id when organiser is chosen", async () => {
    const { app, inserts, rpcRoles } = buildApp();

    const res = await signup(app, { ...VALID, role: "organiser" });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ id: "ORG-0001", role: "organiser" });
    expect(inserts[0].role).toBe("organiser");
    expect(rpcRoles).toEqual(["organiser"]);
    expect(verifyToken(res.body.token)).toMatchObject({ sub: "ORG-0001", role: "organiser" });
  });

  it.each(["coordinator", "venue_staff", "technical_support", "admin", "Organiser", 42])(
    "refuses to self-assign %s and writes nothing",
    async (role) => {
      const { app, inserts, rpcRoles } = buildApp();

      const res = await signup(app, { ...VALID, role });

      expect(res.status).toBe(400);
      expect(res.body.field).toBe("role");
      expect(inserts).toHaveLength(0);
      expect(rpcRoles).toHaveLength(0);
    },
  );
});

describe("POST /api/auth/signup — email already registered (AC2)", () => {
  it("rejects with 409 and says the address is in use", async () => {
    const { app, inserts } = buildApp({ existing: { id: "ATT-0007" } });

    const res = await signup(app, VALID);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "An account with this email already exists",
      field: "email",
      code: "email_in_use",
    });
    expect(inserts).toHaveLength(0);
  });

  it("reports a signup that loses the race to the unique constraint as in-use, not a server error", async () => {
    const { app } = buildApp({
      insertError: {
        message: 'duplicate key value violates unique constraint "users_email_key"',
        code: "23505",
      },
    });

    const res = await signup(app, VALID);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("email_in_use");
  });

  it("does not blame the email when the collision is on the generated id", async () => {
    // A seeded DB whose ID sequence is behind its hand-picked rows
    // (migration 0013): the user's email is fine, so saying it's taken
    // would send them off to a login that can't work.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app } = buildApp({
      insertError: {
        message: 'duplicate key value violates unique constraint "users_pkey"',
        code: "23505",
      },
    });

    const res = await signup(app, { ...VALID, role: "organiser" });

    expect(res.status).toBe(500);
    expect(res.body.code).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("sync_user_id_sequences"));
    errorSpy.mockRestore();
  });
});

describe("POST /api/auth/signup — password strength (AC3)", () => {
  it.each([
    ["too short", "abc123"],
    ["no number", "onlyletters"],
    ["no letter", "1234567890"],
    ["empty", ""],
  ])("rejects a password that is %s and states the rule", async (_label, password) => {
    const { app, inserts } = buildApp();

    const res = await signup(app, { ...VALID, password });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PASSWORD_RULE, field: "password", code: "weak_password" });
    expect(inserts).toHaveLength(0);
  });

  it("accepts exactly 8 characters with a letter and a number", async () => {
    const { app } = buildApp();

    const res = await signup(app, { ...VALID, password: "abcdefg1" });

    expect(res.status).toBe(201);
  });

  it("rejects a password beyond bcrypt's 72-byte limit", async () => {
    const { app } = buildApp();

    const res = await signup(app, { ...VALID, password: "a1".repeat(37) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(PASSWORD_TOO_LONG);
  });

  it("rejects a non-string password", async () => {
    const { app } = buildApp();

    const res = await signup(app, { ...VALID, password: 12345678 });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe("password");
  });
});

describe("POST /api/auth/signup — other validation", () => {
  it.each(["", "   ", undefined])("requires a name (%j)", async (name) => {
    const { app } = buildApp();

    const res = await signup(app, { ...VALID, name });

    expect(res.status).toBe(400);
    expect(res.body.field).toBe("name");
  });

  it.each(["", "not-an-email", "ada@", "@example.com", "ada@example", "ada lovelace@example.com"])(
    "rejects the email %j",
    async (email) => {
      const { app, inserts } = buildApp();

      const res = await signup(app, { ...VALID, email });

      expect(res.status).toBe(400);
      expect(res.body.field).toBe("email");
      expect(inserts).toHaveLength(0);
    },
  );
});

describe("POST /api/auth/signup — infrastructure failures", () => {
  it("reports a failed email lookup as a server error instead of creating the account", async () => {
    const { app, inserts } = buildApp({ lookupError: { message: "connection refused" } });

    const res = await signup(app, VALID);

    expect(res.status).toBe(500);
    expect(inserts).toHaveLength(0);
  });

  it("reports any other insert failure as a server error", async () => {
    const { app } = buildApp({ insertError: { message: "boom", code: "XX000" } });

    const res = await signup(app, VALID);

    expect(res.status).toBe(500);
    expect(res.body.code).toBeUndefined();
  });
});
