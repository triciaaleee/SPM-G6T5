import { Router } from "express";
import { requireAuth, requireAuthOrInternal } from "../middleware/auth.js";
import type { AuthedRequest } from "../middleware/auth.js";

export const usersRouter = Router();

/**
 * Placeholder: returns the caller's own identity from their verified
 * token. Signup/login/user-CRUD still live in events-service for now
 * (see backend/services/events-service/src/routes/auth.ts) — this service
 * is scaffolding only, ready for that logic to move here later.
 */
usersRouter.get("/me", requireAuth, (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});

const MAX_NAME_LOOKUP_IDS = 200;

/**
 * E6: display names for a set of user ids, so registration-service can show
 * a roster without ever reading the users table (user-service owns it).
 * Organisers and coordinators run rosters; technical_support uses this to
 * show which coordinator raised an equipment request (a deliberate
 * exception to E5-1 AC1's "nothing about [the event's] people" — see
 * equipment-service's GET /equipment-requests/event/:eventId). Attendees
 * may not look each other up. Returns id and name only — never email, role
 * or anything else. Ids that don't exist are simply absent.
 */
usersRouter.get("/names", requireAuth, async (req: AuthedRequest, res) => {
  const role = req.user?.role;
  if (role !== "organiser" && role !== "coordinator" && role !== "technical_support") {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const rawIds = typeof req.query.ids === "string" ? req.query.ids : "";
  const ids = [...new Set(rawIds.split(",").map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > MAX_NAME_LOOKUP_IDS) {
    res.status(400).json({ error: `ids must be 1–${MAX_NAME_LOOKUP_IDS} comma-separated user ids` });
    return;
  }

  const { data, error } = await req.supabase!.from("users").select("id, name").in("id", ids);
  if (error) {
    res.status(500).json({ error: "Failed to load users" });
    return;
  }

  res.json({ users: data ?? [] });
});

/**
 * Roles each caller may list, and only those. E2-13/E2-12: the Event
 * Coordinator Lead picks an active coordinator to assign or reassign an
 * event to (events-service checks the choice against this same list).
 * E2-14: an organiser submitting a request needs to notify the Event
 * Coordinator Lead, so events-service resolves Lead ids the same way,
 * forwarding the organiser's own token — events-service's POST /api/events
 * and the draft-submit branch of PATCH /api/events/:id both restrict
 * submission to the organiser role, which is what keeps this listing
 * scoped rather than open to any caller.
 */
const LISTABLE_ROLES_BY_CALLER: Record<string, ReadonlySet<string>> = {
  coordinator_lead: new Set(["coordinator"]),
  organiser: new Set(["coordinator_lead"]),
};

/**
 * Users with a given role: id and display name only — never email,
 * password hash or lockout state. ?role= is required. There's no
 * active/inactive flag on users, so every account with the role counts as
 * active (the same assumption E2-6 made).
 *
 * `requireAuthOrInternal` also lets a sibling service call this with no
 * end-user token (e.g. notification-service resolving a broker message's
 * `recipients.roles`) — that case has no `req.user`, so it's trusted for
 * any role rather than checked against LISTABLE_ROLES_BY_CALLER.
 */
usersRouter.get("/", requireAuthOrInternal, async (req: AuthedRequest, res) => {
  const role = typeof req.query.role === "string" ? req.query.role : "";
  if (!role) {
    res.status(400).json({ error: "role is required" });
    return;
  }

  if (req.user) {
    const allowed = LISTABLE_ROLES_BY_CALLER[req.user.role];
    if (!allowed || !allowed.has(role)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
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
