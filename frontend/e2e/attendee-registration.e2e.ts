import { expect, test } from "@playwright/test";
import {
  approveRequest,
  approveSafetyReview,
  approveVenueBooking,
  assignCoordinator,
  fetchMyVenues,
  registerAttendee,
  registerOrganiser,
  requestVenueBooking,
  signInAsCoordinator,
  signInAsCoordinatorLead,
  signInAsSafetyOfficer,
  signInAsVenueStaff,
  submitEvent,
  submitForSafetyReview,
  uniqueFutureDate,
  uniqueName,
} from "./support/backend";
import { logIn } from "./support/browser";

/**
 * E6: once an event is Confirmed with registrationNeeded true (and hasn't
 * ended — registration-service's "open" rule), an attendee discovers it,
 * views its detail page and registers; it then appears in their own events
 * list as Registered. The full Unassigned -> Confirmed climb is driven
 * through backend.ts; only the attendee's own discover/view/register flow
 * is driven through the browser.
 */

test("attendee discovers a Confirmed, registration-open event and registers for it", async ({ page }) => {
  const organiser = await registerOrganiser("attendee-reg-organiser");
  const attendee = await registerAttendee("attendee-reg-attendee");
  const coordinator = await signInAsCoordinator();
  const lead = await signInAsCoordinatorLead();
  const venueStaff = await signInAsVenueStaff();
  const safetyOfficer = await signInAsSafetyOfficer();

  const eventName = uniqueName("Open For Registration Event");
  const event = await submitEvent(organiser, {
    name: eventName,
    registrationNeeded: true,
    // Far in the future (so "hasn't ended" never flakes) and unique per run
    // so this test's venue booking can't collide with another test's for
    // the same venue and window — see uniqueFutureDate's doc comment.
    proposedDate: uniqueFutureDate(),
  });

  await assignCoordinator(lead, event.id, coordinator.id);
  await approveRequest(coordinator, event.id);

  // Picked from signInAsVenueStaff()'s own venues — see fetchMyVenues's doc
  // comment on why a coordinator's search result isn't safe to use here.
  const myVenues = await fetchMyVenues(venueStaff);
  const booking = await requestVenueBooking(coordinator, event.id, myVenues[0].id);
  await approveVenueBooking(venueStaff, booking.id);

  await submitForSafetyReview(coordinator, event.id);
  await approveSafetyReview(safetyOfficer, event.id);

  // Attendee discovers it.
  await logIn(page, attendee);
  await page.goto("/attendee/discover");
  await expect(page.getByText(eventName)).toBeVisible();

  // Views it and registers from the detail page.
  await page.getByText(eventName).click();
  await expect(page).toHaveURL(new RegExp(`/attendee/events/${event.id}$`));
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText("Registered", { exact: true })).toBeVisible();

  // It now appears in their own events list, under Upcoming, as Registered.
  await page.goto("/attendee/events");
  const card = page.locator(".card-item", { hasText: eventName }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText("Registered", { exact: true })).toBeVisible();
});
