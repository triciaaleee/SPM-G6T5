import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";
import { describe, expect, it, vi } from "vitest";
import { authRouter } from "../routes/auth.js";
import { verifyToken } from "../lib/jwt.js";

process.env.JWT_SECRET = "test-only-secret";

// Delegates to a per-test fake set on globalThis, mirroring the pattern in
// events.test.ts. vi.mock is hoisted, so the indirection is what lets each
// test swap the backing data.
vi.mock("../lib/supabaseAdmin.js", () => ({
  supabaseAdmin: {
    from: (table: string) => (globalThis as any).__mockSupabase.from(table),
  },
}));

const PASSWORD = "correct-horse-battery";
const WRONG_PASSWORD = "not-my-password";
const GENERIC_ERROR = "Invalid email or password";

interface FakeUser {
  id: string;
  name: string;
  email: string;
  role: string;
  password_hash: string;
  // Nullable in the DB (migration 0006): a freshly seeded or pre-backfill
  // row can have no value here.
  failed_login_attempts: number | null;
  locked_until: string | null;
}

function makeUser(overrides: Partial<FakeUser> = {}): FakeUser {
  return {
    id: "ORG-0001",
    name: "Ada",
    email: "ada@example.com",
    role: "organiser",
    // Cost 4 keeps the suite fast; bcrypt.compare reads the cost from the
    // hash itself, so this verifies the same way a cost-10 hash would.
    password_hash: bcrypt.hashSync(PASSWORD, 4),
    failed_login_attempts: 0,
    locked_until: null,
    ...overrides,
  };
}

/** Stands in for the `users` table: one optional row, plus a record of writes. */
function buildApp(user: FakeUser | null, selectError: { message: string } | null = null) {
  const updates: Record<string, unknown>[] = [];

  const maybeSingle = vi.fn(async () => ({ data: selectError ? null : user, error: selectError }));
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const updateEq = vi.fn(async () => ({ error: null }));
  const update = vi.fn((patch: Record<string, unknown>) => {
    updates.push(patch);
    return { eq: updateEq };
  });
  const from = vi.fn().mockReturnValue({ select, update });

  (globalThis as any).__mockSupabase = { from };

  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  return { app, updates, from, select, eq, update, updateEq };
}

function login(app: express.Express, password: string, email = "ada@example.com") {
  return request(app).post("/api/auth/login").send({ email, password });
}

describe("POST /api/auth/login — valid credentials", () => {
  it("returns a token carrying the user's id and role", async () => {
    const { app, from, select, eq } = buildApp(makeUser());

    const res = await login(app, PASSWORD);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: "ORG-0001",
      name: "Ada",
      email: "ada@example.com",
      role: "organiser",
    });
    expect(verifyToken(res.body.token)).toMatchObject({ sub: "ORG-0001", role: "organiser" });
    expect(from).toHaveBeenCalledWith("users");
    expect(select).toHaveBeenCalledWith(
      "id, name, email, role, password_hash, failed_login_attempts, locked_until",
    );
    expect(eq).toHaveBeenCalledWith("email", "ada@example.com");
  });

  it("looks the email up trimmed and lowercased, regardless of how it was typed", async () => {
    const { app, eq } = buildApp(makeUser());

    const res = await login(app, PASSWORD, "  Ada@Example.COM  ");

    expect(res.status).toBe(200);
    expect(eq).toHaveBeenCalledWith("email", "ada@example.com");
  });

  it("never returns the password hash", async () => {
    const { app } = buildApp(makeUser());

    const res = await login(app, PASSWORD);

    expect(JSON.stringify(res.body)).not.toContain("$2");
  });

  it("does not write when the account is already clean", async () => {
    const { app, updates } = buildApp(makeUser());

    await login(app, PASSWORD);

    expect(updates).toHaveLength(0);
  });

  it("clears a partial failure streak", async () => {
    const { app, updates, from, updateEq } = buildApp(makeUser({ failed_login_attempts: 3 }));

    const res = await login(app, PASSWORD);

    expect(res.status).toBe(200);
    expect(updates).toEqual([{ failed_login_attempts: 0, locked_until: null }]);
    // Two separate .from("users") calls — the lookup, then the reset
    // update — each must pass the real table name.
    expect(from).toHaveBeenNthCalledWith(1, "users");
    expect(from).toHaveBeenNthCalledWith(2, "users");
    expect(updateEq).toHaveBeenCalledWith("id", "ORG-0001");
  });
});

describe("POST /api/auth/login — invalid credentials (AC2)", () => {
  it("gives the same 401 and message for an unknown email as for a wrong password", async () => {
    // buildApp swaps a single shared fake, so these run one at a time.
    const { app: unknownEmailApp } = buildApp(null);
    const unknownEmail = await login(unknownEmailApp, PASSWORD, "nobody@example.com");

    const { app: wrongPasswordApp } = buildApp(makeUser());
    const wrongPassword = await login(wrongPasswordApp, WRONG_PASSWORD);

    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.body).toEqual({ error: GENERIC_ERROR });
    expect(wrongPassword.body).toEqual({ error: GENERIC_ERROR });
  });

  it("does not record attempts against an email with no account", async () => {
    const { app, updates } = buildApp(null);

    await login(app, PASSWORD, "nobody@example.com");

    expect(updates).toHaveLength(0);
  });
});

describe("POST /api/auth/login — lockout (AC3)", () => {
  it("counts each failure", async () => {
    const { app, updates, from, updateEq } = buildApp(makeUser({ failed_login_attempts: 1 }));

    await login(app, WRONG_PASSWORD);

    expect(updates).toEqual([{ failed_login_attempts: 2, locked_until: null }]);
    expect(from).toHaveBeenNthCalledWith(1, "users");
    expect(from).toHaveBeenNthCalledWith(2, "users");
    expect(updateEq).toHaveBeenCalledWith("id", "ORG-0001");
  });

  it("treats a null failed_login_attempts (not yet backfilled) as zero, not as NaN", async () => {
    const { app, updates } = buildApp(makeUser({ failed_login_attempts: null }));

    const res = await login(app, WRONG_PASSWORD);

    expect(res.status).toBe(401);
    expect(updates).toEqual([{ failed_login_attempts: 1, locked_until: null }]);
  });

  it("stays unlocked through the 4th failure", async () => {
    const { app } = buildApp(makeUser({ failed_login_attempts: 3 }));

    const res = await login(app, WRONG_PASSWORD);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: GENERIC_ERROR });
  });

  it("locks for 15 minutes on the 5th consecutive failure", async () => {
    const { app, updates, from, updateEq } = buildApp(makeUser({ failed_login_attempts: 4 }));

    const res = await login(app, WRONG_PASSWORD);

    expect(res.status).toBe(423);
    expect(res.body.code).toBe("account_locked");
    expect(res.body.retryAfterMinutes).toBe(15);
    expect(res.body.error).toContain("15 minutes");

    expect(updates).toHaveLength(1);
    expect(updates[0].failed_login_attempts).toBe(5);
    const lockedUntil = new Date(updates[0].locked_until as string).getTime();
    expect(lockedUntil - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(lockedUntil - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    expect(from).toHaveBeenNthCalledWith(1, "users");
    expect(from).toHaveBeenNthCalledWith(2, "users");
    expect(updateEq).toHaveBeenCalledWith("id", "ORG-0001");
  });

  it("uses the singular 'minute' (not 'minutes') when exactly one minute remains", async () => {
    // minutesRemaining rounds up, so a lock expiring 20s from now reads as "1 minute".
    const lockedUntil = new Date(Date.now() + 20_000).toISOString();
    const { app } = buildApp(makeUser({ failed_login_attempts: 5, locked_until: lockedUntil }));

    const res = await login(app, PASSWORD);

    expect(res.status).toBe(423);
    expect(res.body.retryAfterMinutes).toBe(1);
    expect(res.body.error).toContain("in 1 minute.");
    expect(res.body.error).not.toContain("1 minutes");
  });

  it("rejects a locked account even when the password is correct", async () => {
    const lockedUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    const { app, updates } = buildApp(makeUser({ failed_login_attempts: 5, locked_until: lockedUntil }));

    const res = await login(app, PASSWORD);

    expect(res.status).toBe(423);
    expect(res.body.code).toBe("account_locked");
    expect(res.body.retryAfterMinutes).toBe(10);
    expect(res.body.error).toContain("10 minutes");
    // A locked account is a dead end, not another chance to extend the lock.
    expect(updates).toHaveLength(0);
  });

  it("treats a lock whose expiry exactly equals the current instant as expired, not still locked", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const lockedUntil = new Date(now).toISOString();
    const { app, updates } = buildApp(makeUser({ failed_login_attempts: 5, locked_until: lockedUntil }));

    const res = await login(app, WRONG_PASSWORD);

    // Equal, not greater: the lock has just lapsed, so this is an ordinary
    // (unlocked) failed attempt, starting a fresh count.
    expect(res.status).toBe(401);
    expect(updates).toEqual([{ failed_login_attempts: 1, locked_until: null }]);
    vi.restoreAllMocks();
  });

  it("starts a fresh count once the lockout has expired", async () => {
    const expired = new Date(Date.now() - 60_000).toISOString();
    const { app, updates } = buildApp(makeUser({ failed_login_attempts: 5, locked_until: expired }));

    const res = await login(app, WRONG_PASSWORD);

    expect(res.status).toBe(401);
    expect(updates).toEqual([{ failed_login_attempts: 1, locked_until: null }]);
  });

  it("lets the right password through once the lockout has expired", async () => {
    const expired = new Date(Date.now() - 60_000).toISOString();
    const { app, updates } = buildApp(makeUser({ failed_login_attempts: 5, locked_until: expired }));

    const res = await login(app, PASSWORD);

    expect(res.status).toBe(200);
    expect(updates).toEqual([{ failed_login_attempts: 0, locked_until: null }]);
  });
});

describe("POST /api/auth/login — infrastructure failures", () => {
  it("reports a failed lookup as a server error, not as bad credentials", async () => {
    // The failure this guards against: before migration 0006 is applied,
    // selecting failed_login_attempts errors, and reusing the credential
    // branch would tell every user their password was wrong.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const lookupError = { message: "column users.failed_login_attempts does not exist" };
    const { app } = buildApp(makeUser(), lookupError);

    const res = await login(app, PASSWORD);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Something went wrong. Please try again." });
    expect(errorSpy).toHaveBeenCalledWith("Login lookup failed:", lookupError.message);
    errorSpy.mockRestore();
  });
});

describe("POST /api/auth/login — malformed requests", () => {
  it("rejects a missing password without touching the database", async () => {
    const { app, updates, from } = buildApp(makeUser());

    const res = await request(app).post("/api/auth/login").send({ email: "ada@example.com" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Email and password are required" });
    expect(updates).toHaveLength(0);
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects a missing email without touching the database", async () => {
    const { app, from } = buildApp(makeUser());

    const res = await request(app).post("/api/auth/login").send({ password: PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Email and password are required" });
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects a non-string email or password without touching the database", async () => {
    const { app, from } = buildApp(makeUser());

    const res = await request(app).post("/api/auth/login").send({ email: 12345, password: PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Email and password are required" });
    expect(from).not.toHaveBeenCalled();
  });

  it("rejects a request sent with no body at all, instead of throwing on an undefined req.body", async () => {
    // No .send() and no Content-Type: Express leaves req.body as undefined,
    // not {} — only `req.body ?? {}` stands between that and a crash.
    const { app, from } = buildApp(makeUser());

    const res = await request(app).post("/api/auth/login");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Email and password are required" });
    expect(from).not.toHaveBeenCalled();
  });
});
