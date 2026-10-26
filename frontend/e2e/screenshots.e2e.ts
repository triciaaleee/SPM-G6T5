import { test, type Browser } from "@playwright/test";
import path from "node:path";
import {
  climbToConfirmed,
  listEquipmentCatalog,
  openRegistrationToday,
  registerAttendee,
  registerForEvent,
  requestEquipment,
  setEquipmentRequestStatus,
  signInAsTechnicalSupport,
  uniqueName,
  type Session,
} from "./support/backend";
import { signInThroughStorage } from "./support/browser";

/**
 * Not a real test — a one-off visual capture of every page in the app, for a
 * quick UI overview. Seeds one event through Confirmed (with a venue
 * booking, an equipment request and an open attendee registration) so every
 * dynamic-route page has real content, then screenshots every route for
 * every role. Waiting is deliberately approximate (a fixed settle time, not
 * a per-page readiness assertion) since nothing here is actually asserted.
 *
 * Every row this creates is tagged with TAG (in the organiser/attendee name
 * and the event name) so it can be found and deleted later — this writes
 * through the real backend APIs and nothing here cleans up after itself.
 */

const TAG = "SCREENSHOT-TEMP";

test.describe.configure({ timeout: 300_000 });

const OUT_DIR = path.join(import.meta.dirname, "screenshots");

interface Route {
  /** File name for the screenshot (no extension, no slashes). */
  name: string;
  path: string;
}

async function captureAll(browser: Browser, session: Session | null, routes: Route[]): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  if (session) await signInThroughStorage(page, session);
  const folder = session?.role ?? "guest";

  for (const route of routes) {
    await page.goto(route.path, { waitUntil: "load" });
    await page.waitForTimeout(800); // let client-side data fetches/render settle
    await page.screenshot({ path: path.join(OUT_DIR, folder, `${route.name}.png`), fullPage: true });
  }

  await context.close();
}

test("capture a screenshot of every page", async ({ browser }) => {
  const attendee = await registerAttendee(`${TAG}-attendee`);
  const technicalSupport = await signInAsTechnicalSupport();

  const { event, organiser, coordinator, lead, venueStaff, safetyOfficer } = await climbToConfirmed(
    `${TAG}-organiser`,
    { name: uniqueName(`${TAG}-event`), registrationNeeded: true },
    async ({ coordinator: planningCoordinator, event: planningEvent }) => {
      const date = (planningEvent.submitted_details as Record<string, unknown>).proposedDate as string;
      const catalog = await listEquipmentCatalog(planningCoordinator, date);
      if (catalog.length > 0) {
        const request = await requestEquipment(planningCoordinator, planningEvent.id, [
          { equipmentCatalogId: catalog[0].id, quantity: 1 },
        ]);
        // Safety review requires every requested item to be reserved, which only
        // happens once Technical Support arranges it.
        await setEquipmentRequestStatus(technicalSupport, request.id, "Arranged");
      }
    },
  );
  await openRegistrationToday(coordinator, event.id);
  await registerForEvent(attendee, event.id);

  // Guest / public pages — no session.
  await captureAll(browser, null, [
    { name: "welcome", path: "/welcome" },
    { name: "login", path: "/login" },
    { name: "signup", path: "/signup" },
    { name: "explore-events", path: "/explore/events" },
    { name: "explore-event-detail", path: `/explore/events/${event.id}` },
    { name: "explore-venues", path: "/explore/venues" },
  ]);

  await captureAll(browser, organiser, [
    { name: "events-list", path: "/" },
    { name: "events-new", path: "/events/new" },
    { name: "event-detail", path: `/events/${event.id}` },
    { name: "event-edit", path: `/events/${event.id}/edit` },
  ]);

  await captureAll(browser, coordinator, [
    { name: "coordinator-workload", path: "/coordinator" },
    { name: "all-events", path: "/all-events" },
    { name: "event-detail", path: `/events/${event.id}` },
    { name: "venue-search", path: "/venues" },
    { name: "venue-availability", path: "/venue-availability" },
    { name: "notifications", path: "/notifications" },
  ]);

  await captureAll(browser, lead, [
    { name: "lead-dashboard", path: "/lead" },
    { name: "lead-unassigned", path: "/lead/unassigned" },
    { name: "lead-coordinator", path: `/lead/coordinators/${coordinator.id}` },
  ]);

  await captureAll(browser, venueStaff, [{ name: "venue-schedule", path: "/venue-schedule" }]);

  await captureAll(browser, technicalSupport, [
    { name: "equipment-requests", path: "/equipment-requests" },
    { name: "equipment-request-detail", path: `/equipment-requests/event/${event.id}` },
    { name: "equipment-inventory", path: "/equipment-inventory" },
    { name: "equipment-maintenance", path: "/equipment-maintenance" },
  ]);

  await captureAll(browser, safetyOfficer, [{ name: "safety-review-queue", path: "/safety-review" }]);

  await captureAll(browser, attendee, [
    { name: "attendee-events", path: "/attendee/events" },
    { name: "attendee-discover", path: "/attendee/discover" },
    { name: "attendee-event-detail", path: `/attendee/events/${event.id}` },
  ]);
});
