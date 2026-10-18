import { expect, test } from "@playwright/test";
import {
  registerAttendee,
  registerOrganiser,
  signInAsCoordinator,
  signInAsCoordinatorLead,
  signInAsSafetyOfficer,
  signInAsTechnicalSupport,
  signInAsVenueStaff,
  type Session,
} from "./support/backend";
import { signInThroughStorage } from "./support/browser";

/**
 * A representative sweep of the router's role guard (frontend/src/router/
 * index.ts `beforeEach`): for every one of its 19 routes, one role that is
 * NOT permitted on it visits the URL directly, and the guard must redirect
 * them to their own landing route rather than showing the page, a blank
 * screen or a 403. There's no router unit test suite in this repo
 * (frontend/src/router has no __tests__ dir) to duplicate, so this is the
 * only place the guard is exercised for every route.
 *
 * The guard logic itself is uniform (one `roles` check), so one wrong role
 * per route is enough to prove it actually fires in a real browser; this
 * isn't trying to cover all 7 roles x 19 routes.
 *
 * /notifications has no role restriction (any signed-in role may visit it)
 * so it has nothing to sweep here.
 *
 * Route params (:id, :eventId) are given a harmless placeholder — the
 * guard runs in `beforeEach` before the target component ever mounts, so
 * the id's validity doesn't matter for this test.
 */

interface RouteCase {
  path: string;
  /** A role the route's `meta.roles` does NOT include. */
  wrongRole: keyof typeof SESSION_FACTORIES;
}

const SESSION_FACTORIES = {
  attendee: () => registerAttendee("role-access-attendee"),
  organiser: () => registerOrganiser("role-access-organiser"),
  coordinator: signInAsCoordinator,
  coordinator_lead: signInAsCoordinatorLead,
  venue_staff: signInAsVenueStaff,
  technical_support: signInAsTechnicalSupport,
  safety_officer: signInAsSafetyOfficer,
} as const;

const ROUTES: RouteCase[] = [
  { path: "/", wrongRole: "attendee" },
  { path: "/attendee/events", wrongRole: "organiser" },
  { path: "/attendee/discover", wrongRole: "organiser" },
  { path: "/attendee/events/1", wrongRole: "organiser" },
  { path: "/events/new", wrongRole: "attendee" },
  { path: "/events/1/edit", wrongRole: "attendee" },
  { path: "/events/1", wrongRole: "venue_staff" },
  { path: "/coordinator", wrongRole: "attendee" },
  { path: "/venues", wrongRole: "attendee" },
  { path: "/venue-requests", wrongRole: "coordinator" },
  { path: "/venue-availability", wrongRole: "venue_staff" },
  { path: "/venue-schedule", wrongRole: "coordinator" },
  { path: "/equipment-requests", wrongRole: "coordinator" },
  { path: "/equipment-requests/event/1", wrongRole: "coordinator" },
  { path: "/equipment-inventory", wrongRole: "coordinator" },
  { path: "/lead", wrongRole: "venue_staff" },
  { path: "/lead/unassigned", wrongRole: "venue_staff" },
  { path: "/lead/coordinators/1", wrongRole: "venue_staff" },
  { path: "/safety-review", wrongRole: "coordinator" },
];

/** frontend/src/lib/auth.ts LANDING_ROUTE_BY_ROLE, mirrored here via each Session's own landingPath. */
async function sessionFor(role: RouteCase["wrongRole"]): Promise<Session> {
  return SESSION_FACTORIES[role]();
}

for (const { path, wrongRole } of ROUTES) {
  test(`${wrongRole} visiting ${path} is redirected away, not shown the page`, async ({ page }) => {
    const session = await sessionFor(wrongRole);
    await signInThroughStorage(page, session);
    await page.goto(path);
    // Matched on pathname only: a landing view may append its own default
    // query (e.g. VenueStaff.vue adding ?venue=&date=&tab= once it mounts)
    // which is that component's own state, not part of what the router
    // guard itself decided.
    const escapedPath = session.landingPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await expect(page).toHaveURL(new RegExp(`${escapedPath}(\\?.*)?$`));
  });
}
