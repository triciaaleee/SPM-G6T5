import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const usersRouter = Router();

usersRouter.use(requireAuth);

/**
 * Placeholder: returns the caller's own identity from their verified
 * token. Signup/login/user-CRUD still live in events-service for now
 * (see backend/services/events-service/src/routes/auth.ts) — this service
 * is scaffolding only, ready for that logic to move here later.
 */
usersRouter.get("/me", (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});

/**
 * Roles each caller may list, and only those. E2-13/E2-12: the Event
 * Coordinator Lead picks an active coordinator to assign or reassign an
 * event to (events-service checks the choice against this same list).
 */
const LISTABLE_ROLES_BY_CALLER: Record<string, ReadonlySet<string>> = {
  coordinator_lead: new Set(["coordinator"]),
};

/**
 * Users with a given role: id and display name only — never email,
 * password hash or lockout state. ?role= is required. There's no
 * active/inactive flag on users, so every account with the role counts as
 * active (the same assumption E2-6 made).
 */
usersRouter.get("/", async (req: AuthedRequest, res) => {
  const role = typeof req.query.role === "string" ? req.query.role : "";
  const allowed = LISTABLE_ROLES_BY_CALLER[req.user!.role];

  if (!allowed || !allowed.has(role)) {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { data, error } = await req
    .supabase!.from("users")
    .select("id, name")
    .eq("role", role)
    .order("name", { ascending: true });

  if (error) {
    res.status(500).json({ error: "Failed to load users" });
    return;
  }

  res.json({ users: data ?? [] });
});
