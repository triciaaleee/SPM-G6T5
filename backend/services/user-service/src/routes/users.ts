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

const MAX_NAME_LOOKUP_IDS = 200;

/**
 * E6: display names for a set of user ids, so registration-service can show
 * a roster without ever reading the users table (user-service owns it).
 * Only organisers and coordinators run rosters; attendees may not look each
 * other up. Returns id and name only — never email, role or anything else.
 * Ids that don't exist are simply absent.
 */
usersRouter.get("/names", async (req: AuthedRequest, res) => {
  const role = req.user?.role;
  if (role !== "organiser" && role !== "coordinator") {
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
