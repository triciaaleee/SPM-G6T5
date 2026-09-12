import { Router } from "express";
import bcrypt from "bcryptjs";
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { signToken } from "../lib/jwt.js";

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

authRouter.post("/signup", async (req, res) => {
  const { name, email, password } = req.body ?? {};

  if (typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  if (typeof email !== "string" || !email.trim()) {
    res.status(400).json({ error: "Email is required" });
    return;
  }
  if (typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  const { data: existing } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();

  if (existing) {
    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }

  const { data: generatedId, error: idError } = await supabaseAdmin.rpc("generate_user_id", {
    p_role: "attendee",
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
      email: email.trim().toLowerCase(),
      password_hash: passwordHash,
      role: "attendee",
    })
    .select("id, name, email, role")
    .single();

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
