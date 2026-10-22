import { expect, test } from "@playwright/test";
import {
  approveRequest,
  assignCoordinator,
  approveVenueBooking,
  expectRefused,
  fetchEventBookings,
  fetchMyNotifications,
  fetchMyVenues,
  registerOrganiser,
  requestVenueBooking,
  signInAsCoordinator,
  signInAsCoordinatorLead,
  signInAsVenueStaff,
  submitEvent,
  uniqueFutureDate,
  uniqueName,
} from "./support/backend";
import { signInThroughStorage } from "./support/browser";

/**
 * E4-8/E4-10 (AGENTS.md §3a): a coordinator requests a venue booking from
 * the UI, it appears Requested in the event's Venue Requests panel; Venue
 * Staff see the same booking in their decision queue (the Requests tab of
 * /venue-schedule, which /venue-requests redirects to) and
 * approve it there; both sides then show Approved.
 */

test("coordinator requests a venue through the search page, then Venue Staff approves it", async ({ page }) => {
  const organiser = await registerOrganiser("venue-booking-organiser");
  const coordinator = await signInAsCoordinator();
  const lead = await signInAsCoordinatorLead();
  const venueStaff = await signInAsVenueStaff();

  const eventName = uniqueName("Venue Booking Event");
  // A unique date so this test's booking can't collide with another test's
  // for the same venue and window — see uniqueFutureDate's doc comment.
  const event = await submitEvent(organiser, { name: eventName, proposedDate: uniqueFutureDate() });
  await assignCoordinator(lead, event.id, coordinator.id);
  await approveRequest(coordinator, event.id); // Requested -> Planning

  // Picked from signInAsVenueStaff()'s own venues (see fetchMyVenues's doc
  // comment): the dev DB has more than one venue_staff account, so a
  // coordinator's search result isn't guaranteed to be one this
  // venueStaff may decide on.
  const myVenues = await fetchMyVenues(venueStaff);
  expect(myVenues.length).toBeGreaterThan(0);
  const venue = myVenues[0];

  // Coordinator requests a venue from the real search UI, opened from the event (?eventId=).
  await signInThroughStorage(page, coordinator);
  await page.goto(`/venues?eventId=${event.id}`);
  const venueCard = page.locator(".venue-card", { hasText: venue.name }).first();
  await expect(venueCard).toBeVisible();
  await venueCard.getByRole("button", { name: /request this venue/i }).click();
  await expect(venueCard.getByText(/requested — awaiting venue staff/i)).toBeVisible();

  // It shows Requested on the event's own Venue Requests panel, which sits
  // on the event page's Arrangements tab.
  await page.goto(`/events/${event.id}`);
  await page.getByRole("button", { name: /^Arrangements/ }).click();
  const requestRow = page.locator(".request-row", { hasText: venue.name }).first();
  await expect(requestRow.getByText("Requested", { exact: true })).toBeVisible();

  // Venue Staff see the same request in their decision queue and approve it.
  // /venue-requests redirects to the Requests tab of their venue schedule.
  await signInThroughStorage(page, venueStaff);
  await page.goto("/venue-requests");
  const queueCard = page.locator("li.row", { hasText: eventName }).first();
  await expect(queueCard).toBeVisible();
  await expect(queueCard.getByText(venue.name)).toBeVisible();
  await queueCard.getByRole("button", { name: "Approve", exact: true }).click();
  // The decision waits its turn on venue-service's per-venue lock, which
  // other parallel tests booking the same venue may be holding.
  await expect(page.getByText(/is approved/i)).toBeVisible({ timeout: 15_000 });

  // Both sides now show Approved: the queue empties this row, and the
  // event's own panel updates — viewed as the coordinator, since
  // /events/:id isn't one of venue_staff's allowed routes (the router
  // would just redirect them away from it).
  await signInThroughStorage(page, coordinator);
  await page.goto(`/events/${event.id}`);
  await page.getByRole("button", { name: /^Arrangements/ }).click();
  const approvedRow = page.locator(".request-row", { hasText: venue.name }).first();
  await expect(approvedRow.getByText("Approved", { exact: true })).toBeVisible();
});

/**
 * E4-11 (AGENTS.md §3a, "First to reach On Hold or Approved wins"): two
 * events want the same venue for the same window. Both requests may sit in
 * Requested together, but the moment Venue Staff approve one, the other is
 * rejected automatically with the fixed reason, and its coordinator is told.
 * After that, a new request for the same window is refused at submission.
 */
test("approving one of two overlapping requests auto-rejects the other, and blocks new ones", async () => {
  test.setTimeout(60_000);
  const organiser = await registerOrganiser("venue-conflict-organiser");
  const [coordinator, lead, venueStaff] = await Promise.all([
    signInAsCoordinator(),
    signInAsCoordinatorLead(),
    signInAsVenueStaff(),
  ]);
  const date = uniqueFutureDate();

  async function plannedEvent(label: string) {
    const event = await submitEvent(organiser, {
      name: uniqueName(label),
      proposedDate: date,
    });
    await assignCoordinator(lead, event.id, coordinator.id);
    await approveRequest(coordinator, event.id);
    return event;
  }
  const [winner, loser, late] = await Promise.all([
    plannedEvent("Conflict Winner"),
    plannedEvent("Conflict Loser"),
    plannedEvent("Conflict Latecomer"),
  ]);

  const myVenues = await fetchMyVenues(venueStaff);
  const venue = myVenues[Math.floor(Math.random() * myVenues.length)];
  const winning = await requestVenueBooking(coordinator, winner.id, venue.id);
  const losing = await requestVenueBooking(coordinator, loser.id, venue.id);
  expect(losing.status).toBe("Requested"); // Requested doesn't block the venue

  await approveVenueBooking(venueStaff, winning.id);

  const [lost] = (await fetchEventBookings(coordinator, loser.id)).filter((b) => b.id === losing.id);
  expect(lost.status).toBe("Rejected");
  expect(lost.decisionReason).toBe("Venue no longer available for this period");
  expect((await fetchEventBookings(coordinator, winner.id)).map((b) => b.status)).toEqual(["Approved"]);

  await expect
    .poll(
      async () =>
        (await fetchMyNotifications(coordinator, 50)).some(
          (n) => n.eventId === loser.id && /reject/i.test(n.title + n.body),
        ),
      {
        message: "waiting for the auto-rejection notification",
        timeout: 15_000,
      },
    )
    .toBe(true);

  // E4-8: a new request overlapping an Approved booking is refused on submission.
  await expectRefused(requestVenueBooking(coordinator, late.id, venue.id), 409);
});
