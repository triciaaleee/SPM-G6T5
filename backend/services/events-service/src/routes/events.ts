import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { internalRouter } from "./events/internal.js";
import { draftsRouter } from "./events/drafts.js";
import { assignmentRouter } from "./events/assignment.js";
import { reviewRouter } from "./events/review.js";
import { lifecycleRouter } from "./events/lifecycle.js";
import { safetyReviewRouter } from "./events/safetyReview.js";
import { changeRequestsRouter } from "./events/changeRequests.js";
import { registrationRouter } from "./events/registration.js";
import { requestsRouter } from "./events/requests.js";

/**
 * /api/events: one router per controller (see c4_diagrams/c3/c3-events-service.dsl),
 * put together here. Mount order matters:
 * - internalRouter goes ahead of requireAuth, since its callers are other
 *   services that bring their own auth.
 * - requestsRouter goes last: its GET /:id would otherwise swallow the fixed
 *   paths other routers define (/unassigned, /safety-review-queue,
 *   /attendee-info, /open-for-registration).
 */
export const eventsRouter = Router();

// Service-to-service routes; they bring their own auth, so they go first.
eventsRouter.use(internalRouter);

eventsRouter.use(requireAuth);
eventsRouter.use(draftsRouter);
eventsRouter.use(assignmentRouter);
eventsRouter.use(reviewRouter);
eventsRouter.use(lifecycleRouter);
eventsRouter.use(safetyReviewRouter);
eventsRouter.use(changeRequestsRouter);
eventsRouter.use(registrationRouter);
eventsRouter.use(requestsRouter);
