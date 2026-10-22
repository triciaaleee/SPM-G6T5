import { expect, test } from "@playwright/test";
import {
  approveVenueBooking,
  blockOutVenue,
  climbToConfirmed,
  climbToSafetyReview,
  expectRefused,
  fetchEventBookings,
  fetchMyNotifications,
  fetchMyVenues,
  getEvent,
  requestVenueBooking,
  submitForSafetyReview,
} from "./support/backend";

/**
 * Week 7 change 2 (AGENTS.md §3 and §3a): a venue becomes unavailable after
 * an event has booked it. Venue Staff block it out in venue-service; the
 * Approved booking is Cancelled there, and venue-service tells events-service
 * the event's arrangements changed. A Confirmed event moves to Needs Review
 * (its safety approval no longer holds); one still in Safety Review goes back
 * to Planning. Nothing is cancelled, and the coordinator can recover by
 * booking another venue and passing safety review again.
 */

test.describe.configure({ timeout: 90_000 });

test("blocking out a Confirmed event's venue cancels the booking and sends the event to Needs Review", async () => {
  const { event, organiser, coordinator, venueStaff, venue, booking } = await climbToConfirmed("blockout-confirmed");
  const date = String(event.submitted_details.proposedDate);
  const reason = "Burst pipe in the ceiling";

  await blockOutVenue(venueStaff, venue.id, date, reason);

  const [cancelled] = (await fetchEventBookings(coordinator, event.id)).filter((b) => b.id === booking.id);
  expect(cancelled.status).toBe("Cancelled");
  expect(cancelled.decisionReason).toContain(reason);
  // The event itself is kept, not cancelled: it needs review.
  expect((await getEvent(organiser, event.id)).status).toBe("Needs Review");

  await expect
    .poll(
      async () =>
        (await fetchMyNotifications(coordinator, 50)).some(
          (n) => n.eventId === event.id && n.type === "booking.replacement_required",
        ),
      { message: "waiting for the coordinator's replacement-required notification", timeout: 15_000 },
    )
    .toBe(true);

  // The blocked venue can't be requested again for that day (E4-8).
  await expectRefused(requestVenueBooking(coordinator, event.id, venue.id), 409);

  // Recovery: book another venue, then the event must pass Safety Review again.
  const replacementVenue = (await fetchMyVenues(venueStaff)).find((v) => v.id !== venue.id);
  expect(replacementVenue, "the seed gives venue-staff-one more than one venue").toBeDefined();
  const replacement = await requestVenueBooking(coordinator, event.id, replacementVenue!.id);
  await approveVenueBooking(venueStaff, replacement.id);
  const resubmitted = await submitForSafetyReview(coordinator, event.id);
  expect(resubmitted.status).toBe("Safety Review");
});

test("blocking out the venue of an event under Safety Review sends it back to Planning", async () => {
  const { event, organiser, venueStaff, venue } = await climbToSafetyReview("blockout-in-review");

  await blockOutVenue(venueStaff, venue.id, String(event.submitted_details.proposedDate), "Fire safety inspection");

  expect((await getEvent(organiser, event.id)).status).toBe("Planning");
});

test("a block-out on another day leaves the booking and the event alone", async () => {
  const { event, organiser, coordinator, venueStaff, venue, booking } = await climbToConfirmed("blockout-other-day");
  const eventDate = new Date(`${String(event.submitted_details.proposedDate)}T00:00:00Z`);
  const dayBefore = new Date(eventDate.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  await blockOutVenue(venueStaff, venue.id, dayBefore, "Repainting");

  const [untouched] = (await fetchEventBookings(coordinator, event.id)).filter((b) => b.id === booking.id);
  expect(untouched.status).toBe("Approved");
  expect((await getEvent(organiser, event.id)).status).toBe("Confirmed");
});
