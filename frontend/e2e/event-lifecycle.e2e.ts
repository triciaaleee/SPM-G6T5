import { expect, test } from "@playwright/test";
import {
  approveRequest,
  approveSafetyReview,
  assignCoordinator,
  fetchMyVenues,
  getEvent,
  registerOrganiser,
  rejectRequest,
  requestVenueBooking,
  approveVenueBooking,
  signInAsCoordinator,
  signInAsCoordinatorLead,
  signInAsSafetyOfficer,
  signInAsVenueStaff,
  submitEvent,
  submitForSafetyReview,
  uniqueFutureDate,
  uniqueName,
} from "./support/backend";
import { expectEventStatus, logIn, signInThroughStorage } from "./support/browser";

/**
 * The full event lifecycle (AGENTS.md §3): Draft is skipped (every test
 * submits directly), so this covers Unassigned -> Requested -> Planning ->
 * Safety Review -> Confirmed, plus the Requested -> Rejected branch. Each
 * transition is driven through backend.ts except the one UI assertion the
 * test is actually about, per e2e/README.md.
 */

test.describe("Event lifecycle happy path", () => {
  test("submit -> assign -> approve -> safety review -> confirm, each visible in the right place", async ({
    page,
  }) => {
    // The climb to Confirmed runs a dozen real API calls, including a venue
    // decision that queues behind other parallel tests' decisions for the same
    // venue (venue-service's per-venue lock), so it needs more than the
    // default 30s.
    test.setTimeout(60_000);
    const organiser = await registerOrganiser("lifecycle-organiser");
    const coordinator = await signInAsCoordinator();
    const lead = await signInAsCoordinatorLead();
    const safetyOfficer = await signInAsSafetyOfficer();
    const venueStaff = await signInAsVenueStaff();

    const eventName = uniqueName("Lifecycle Event");
    // A unique date (not eventDetails()'s fixed default) so this test's
    // venue booking never collides with another test's for the same venue
    // and window (AGENTS.md §3a: whichever reaches On Hold/Approved first
    // wins, and the other is auto-rejected) — see uniqueFutureDate's doc
    // comment.
    const event = await submitEvent(organiser, { name: eventName, proposedDate: uniqueFutureDate() });
    expect(event.status).toBe("Unassigned");

    // 1. Appears in the Lead's unassigned queue.
    await signInThroughStorage(page, lead);
    await page.goto("/lead/unassigned");
    await expect(page.getByText(eventName)).toBeVisible();

    // Lead assigns the coordinator (Unassigned -> Requested).
    const assigned = await assignCoordinator(lead, event.id, coordinator.id);
    expect(assigned.status).toBe("Requested");
    expect(assigned.coordinator_id).toBe(coordinator.id);

    // 2. Appears in that coordinator's workload.
    await signInThroughStorage(page, coordinator);
    await page.goto("/coordinator");
    await expect(page.getByText(eventName)).toBeVisible();

    // Coordinator approves (Requested -> Planning).
    const planning = await approveRequest(coordinator, event.id);
    expect(planning.status).toBe("Planning");

    // 3. Visible as Planning on the event detail page.
    await page.goto(`/events/${event.id}`);
    await expectEventStatus(page, "Planning");

    // Book and approve a venue — required before Planning -> Safety Review.
    // Picked from signInAsVenueStaff()'s own venues (see fetchMyVenues's doc
    // comment): the dev DB has more than one venue_staff account, so not
    // every venue a coordinator can see is one this venueStaff may decide on.
    const myVenues = await fetchMyVenues(venueStaff);
    expect(myVenues.length).toBeGreaterThan(0);
    const booking = await requestVenueBooking(coordinator, event.id, myVenues[0].id);
    await approveVenueBooking(venueStaff, booking.id);

    const safetyReview = await submitForSafetyReview(coordinator, event.id);
    expect(safetyReview.status).toBe("Safety Review");

    // 4. Safety Officer sees and approves it on /safety-review.
    await signInThroughStorage(page, safetyOfficer);
    await page.goto("/safety-review");
    await expect(page.getByText(eventName)).toBeVisible();

    const confirmed = await approveSafetyReview(safetyOfficer, event.id);
    expect(confirmed.status).toBe("Confirmed");

    // 5. Event shows Confirmed on its detail page (viewed as the organiser,
    // the owner). signInThroughStorage, not logIn: the page already has an
    // authenticated session from an earlier role in this test, and logIn's
    // page.goto("/login") would just be bounced straight back out by the
    // router's own already-authenticated redirect (proven in auth.e2e.ts)
    // before the form ever rendered.
    await signInThroughStorage(page, organiser);
    await page.goto(`/events/${event.id}`);
    await expectEventStatus(page, "Confirmed");

    const final = await getEvent(organiser, event.id);
    expect(final.status).toBe("Confirmed");
  });
});

test.describe("Event lifecycle: rejection branch", () => {
  test("coordinator rejects a request -> Rejected, visible on the event page", async ({ page }) => {
    const organiser = await registerOrganiser("lifecycle-reject-organiser");
    const coordinator = await signInAsCoordinator();
    const lead = await signInAsCoordinatorLead();

    const eventName = uniqueName("Reject Me Event");
    const event = await submitEvent(organiser, { name: eventName });
    await assignCoordinator(lead, event.id, coordinator.id);

    const rejected = await rejectRequest(coordinator, event.id, "Does not fit the venue calendar this term.");
    expect(rejected.status).toBe("Rejected");

    await logIn(page, organiser);
    await page.goto(`/events/${event.id}`);
    await expectEventStatus(page, "Rejected");
  });
});
