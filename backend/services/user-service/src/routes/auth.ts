import { Router } from "express";
import bcrypt from "bcryptjs";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { signToken } from "../lib/jwt.js";
import { passwordProblem } from "../lib/passwordPolicy.js";

export const authRouter = Router();

const BCRYPT_ROUNDS = 10;

/**
 * E1-2 lockout policy (issue #9, PRD open question Q4). Team-chosen — the
 * customer gave no requirement — so both numbers live here, in one place,
 * ready to change when Q4 is answered. The per-user counters they drive
 * are columns on `users` (migration 0006).
 */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const LOCKOUT_MS = LOCKOUT_MINUTES * 60 * 1000;

/**
 * AC2: a failed login must not reveal which field was wrong, so every
 * credential failure — unknown email or bad password — returns this exact
 * string with the same 401 status.
 */
const GENERIC_CREDENTIALS_ERROR = "Invalid email or password";

/**
 * A wrong email short-circuits before any password hashing, which would
 * make "no such account" measurably faster to respond than "wrong
 * password" and leak the same thing the generic message hides. Comparing
 * against a throwaway hash of the same cost factor keeps the two paths
 * roughly equal in time. Computed once at startup (~50ms).
 */
const TIMING_DECOY_HASH = bcrypt.hashSync("timing-decoy", BCRYPT_ROUNDS);

function minutesRemaining(until: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60000));
}

function lockoutMessage(until: Date): string {
  const mins = minutesRemaining(until);
  return `Too many failed sign-in attempts. This account is locked — try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
}

/**
 * E1-1 (issue #8): the only roles anyone can give themselves. Coordinator,
 * venue staff and technical support are internal staff accounts seeded
 * directly into the database (no admin role, no onboarding flow), so
 * they're deliberately absent. This list is enforced here, not just in
 * the signup form: without it, anyone could POST `role: "coordinator"`
 * and approve their own events.
 */
const SELF_SIGNUP_ROLES = ["attendee", "organiser"] as const;
type SelfSignupRole = (typeof SELF_SIGNUP_ROLES)[number];

/** AC4: a signup that doesn't pick a role is an attendee. */
const DEFAULT_SIGNUP_ROLE: SelfSignupRole = "attendee";

/**
 * Deliberately loose — the only real test of an address is mailing it,
 * which is out of scope. This just rejects things that plainly aren't
 * one (no @, no domain, embedded spaces). 254 is the SMTP path limit.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;

const EMAIL_IN_USE_ERROR = "An account with this email already exists";

/** Postgres unique_violation — here, a second signup racing past the pre-check. */
const PG_UNIQUE_VIOLATION = "23505";

function isSelfSignupRole(value: unknown): value is SelfSignupRole {
  return SELF_SIGNUP_ROLES.includes(value as SelfSignupRole);
}

authRouter.post("/signup", async (req, res) => {
  const { name, email, password, role } = req.body ?? {};

  // `field` tells the form which input to put the message under.
  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Name is required", field: "name" });
    return;
  }
  if (typeof email !== "string" || !email.trim()) {
    res.status(400).json({ error: "Email is required", field: "email" });
    return;
  }
  const normalisedEmail = email.trim().toLowerCase();
  if (normalisedEmail.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(normalisedEmail)) {
    res.status(400).json({ error: "Enter a valid email address", field: "email" });
    return;
  }
  if (typeof password !== "string") {
    res.status(400).json({ error: "Password is required", field: "password" });
    return;
  }
  // AC3: every rejection states the rule, not just "too weak".
  const problem = passwordProblem(password);
  if (problem) {
    res.status(400).json({ error: problem, field: "password", code: "weak_password" });
    return;
  }
  if (role !== undefined && role !== null && !isSelfSignupRole(role)) {
    res.status(400).json({
      error: "You can only sign up as an Attendee or an Event Organiser",
      field: "role",
    });
    return;
  }
  const accountRole: SelfSignupRole = role ?? DEFAULT_SIGNUP_ROLE;

  const { data: existing, error: lookupError } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("email", normalisedEmail)
    .maybeSingle();

  // Same reasoning as login: a failed lookup must not read as "email is
  // free" and carry on to an insert that fails for a different reason.
  if (lookupError) {
    console.error("Signup lookup failed:", lookupError.message);
    res.status(500).json({ error: "Failed to create account" });
    return;
  }

  // AC2
  if (existing) {
    res.status(409).json({ error: EMAIL_IN_USE_ERROR, field: "email", code: "email_in_use" });
    return;
  }

  const { data: generatedId, error: idError } = await supabaseAdmin.rpc("generate_user_id", {
    p_role: accountRole,
  });

  if (idError || !generatedId) {
    res.status(500).json({ error: "Failed to create account" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const { data: user, error } = await supabaseAdmin
    .from("users")
    .insert({
      id: generatedId,
      name: name.trim(),
      email: normalisedEmail,
      password_hash: passwordHash,
      role: accountRole,
    })
    .select("id, name, email, role")
    .single();

  if (error?.code === PG_UNIQUE_VIOLATION) {
    // Two signups with the same email can both pass the pre-check above;
    // the unique constraint on users.email catches the second. That's
    // still AC2's "address is in use", not a server fault.
    if (/email/i.test(`${error.message} ${error.details ?? ""}`)) {
      res.status(409).json({ error: EMAIL_IN_USE_ERROR, field: "email", code: "email_in_use" });
      return;
    }
    // Anything else is the primary key: the role's ID sequence is behind
    // rows inserted with hand-picked IDs (seed data). The user did nothing
    // wrong, so don't blame their email — log it for whoever runs the DB.
    console.error(
      `Signup ID collision on ${generatedId}; run \`select sync_user_id_sequences();\` (migration 0013).`,
    );
  }

  if (error || !user) {
    res.status(500).json({ error: "Failed to create account" });
    return;
  }

  const token = signToken({ sub: user.id, role: user.role });
  res.status(201).json({ token, user });
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body ?? {};

  if (typeof email !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const { data: user, error } = await supabaseAdmin
    .from("users")
    .select("id, name, email, role, password_hash, failed_login_attempts, locked_until")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();

  // A query failure is not a credential failure. Collapsing the two (the
  // tempting `error || !user`) means a missing migration, a revoked
  // service-role key, or a Supabase outage all present as "Invalid email
  // or password" — for every account at once, with nothing in the UI to
  // distinguish it from genuinely mistyping your password.
  if (error) {
    console.error("Login lookup failed:", error.message);
    res.status(500).json({ error: "Something went wrong. Please try again." });
    return;
  }

  if (!user) {
    await bcrypt.compare(password, TIMING_DECOY_HASH);
    res.status(401).json({ error: GENERIC_CREDENTIALS_ERROR });
    return;
  }

  const lockedUntil = user.locked_until ? new Date(user.locked_until) : null;
  const stillLocked = lockedUntil !== null && lockedUntil.getTime() > Date.now();

  if (stillLocked) {
    // AC3 requires telling the user how long to wait, which unavoidably
    // confirms the account exists. That's the acceptance criterion's
    // deliberate trade-off: a locked account is worth naming so a real
    // user isn't left guessing. Ordinary credential failures above stay
    // generic.
    res.status(423).json({
      error: lockoutMessage(lockedUntil),
      code: "account_locked",
      retryAfterMinutes: minutesRemaining(lockedUntil),
    });
    return;
  }

  // A lockout that has run its course is a clean slate — start counting
  // again from zero rather than resuming at 5 and re-locking on the next
  // typo. No cleanup job needed; the stale timestamp is simply ignored.
  const priorFailures = lockedUntil ? 0 : (user.failed_login_attempts ?? 0);

  const passwordMatches = await bcrypt.compare(password, user.password_hash);

  if (!passwordMatches) {
    const attempts = priorFailures + 1;

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      const until = new Date(Date.now() + LOCKOUT_MS);
      await supabaseAdmin
        .from("users")
        .update({ failed_login_attempts: attempts, locked_until: until.toISOString() })
        .eq("id", user.id);

      res.status(423).json({
        error: lockoutMessage(until),
        code: "account_locked",
        retryAfterMinutes: LOCKOUT_MINUTES,
      });
      return;
    }

    await supabaseAdmin
      .from("users")
      .update({ failed_login_attempts: attempts, locked_until: null })
      .eq("id", user.id);

    res.status(401).json({ error: GENERIC_CREDENTIALS_ERROR });
    return;
  }

  // Only write on success when there's something to clear, so the common
  // case (clean login) stays a single read.
  if (priorFailures > 0 || user.locked_until) {
    await supabaseAdmin
      .from("users")
      .update({ failed_login_attempts: 0, locked_until: null })
      .eq("id", user.id);
  }

  const token = signToken({ sub: user.id, role: user.role });
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

/**
 * There is deliberately no POST /logout. The session is a stateless JWT —
 * the server holds nothing to tear down, so logout is the frontend
 * discarding the token (see frontend/src/lib/auth.ts `logout`). A
 * server-side endpoint would be a no-op that implies a guarantee it
 * can't make. If tokens ever need to die before their `exp` (E1-2 AC4
 * on a shared machine, say), that needs a revocation list, not an
 * endpoint that returns 200 and does nothing.
 */
