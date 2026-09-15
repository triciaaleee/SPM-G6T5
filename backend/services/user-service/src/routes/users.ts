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
