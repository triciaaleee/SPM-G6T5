import { expect, test } from "@playwright/test";
import {
  approveRequest,
  approveVenueBooking,
  assignCoordinator,
  expectRefused,
  fetchEventBookings,
  fetchMyVenues,
  holdVenueBooking,
  registerOrganiser,
  requestVenueBooking,
  signInAsCoordinator,
  signInAsCoordinatorLead,
  signInAsVenueStaff,
  submitEvent,
  uniqueFutureDate,
  uniqueName,
} from "./support/backend";
import { timeTravel } from "./support/database";

/**
 * Week 7 change 4 (AGENTS.md §3a): Venue Staff may hold a venue for a fixed
 * 72 hours while the coordinator finalises. A hold blocks the venue like an
 * approval (and auto-rejects overlapping requests) but only until it
 * expires; a lapsed hold is Expired, can't be decided any more, and stops
 * blocking the venue — even before any scheduled sweep has run.
 */

test.describe.configure({ timeout: 60_000 });

const HOLD_HOURS = 72;

/** Three Planning events wanting the same venue for the same window. */
async function rivalsForOneVenue(label: string) {
  const organiser = await registerOrganiser(`${label}-organiser`);
  const [coordinator, lead, venueStaff] = await Promise.all([
    signInAsCoordinator(),
    signInAsCoordinatorLead(),
    signInAsVenueStaff(),
  ]);
  const date = uniqueFutureDate();
  const planned = async (name: string) => {
    const event = await submitEvent(organiser, { name: uniqueName(name), proposedDate: date });
    await assignCoordinator(lead, event.id, coordinator.id);
    await approveRequest(coordinator, event.id);
    return event;
  };
  const events = await Promise.all([planned("Hold A"), planned("Hold B"), planned("Hold C")]);
  const venues = await fetchMyVenues(venueStaff);
  const venue = venues[Math.floor(Math.random() * venues.length)];
  return { coordinator, venueStaff, venue, events };
}

test("a hold blocks the venue for 72 hours and auto-rejects the overlapping request; it can then be approved", async () => {
  const { coordinator, venueStaff, venue, events } = await rivalsForOneVenue("hold");
  const [a, b, c] = events;
  const requestA = await requestVenueBooking(coordinator, a.id, venue.id);
  const requestB = await requestVenueBooking(coordinator, b.id, venue.id);

  const held = await holdVenueBooking(venueStaff, requestA.id);
  expect(held.status).toBe("On Hold");

  const [heldRow] = await fetchEventBookings(coordinator, a.id);
  const hoursLeft = (Date.parse(heldRow.holdExpiresAt!) - Date.now()) / (60 * 60 * 1000);
  expect(hoursLeft).toBeGreaterThan(HOLD_HOURS - 1);
  expect(hoursLeft).toBeLessThanOrEqual(HOLD_HOURS);

  const [lost] = (await fetchEventBookings(coordinator, b.id)).filter((x) => x.id === requestB.id);
  expect(lost.status).toBe("Rejected");
  await expectRefused(requestVenueBooking(coordinator, c.id, venue.id), 409);

  const approved = await approveVenueBooking(venueStaff, requestA.id);
  expect(approved.status).toBe("Approved");
  expect((await fetchEventBookings(coordinator, a.id))[0].holdExpiresAt).toBeNull();
});

test("a lapsed hold is Expired, can't be approved, and no longer blocks the venue", async () => {
  test.skip(!timeTravel, "needs the local throwaway database (see e2e/README.md)");
  const { coordinator, venueStaff, venue, events } = await rivalsForOneVenue("hold-expiry");
  const [a, , c] = events;
  const requestA = await requestVenueBooking(coordinator, a.id, venue.id);
  await holdVenueBooking(venueStaff, requestA.id);

  await timeTravel!.expireHold(requestA.id);

  // The venue is free again straight away: a new request for the same window is accepted.
  const fresh = await requestVenueBooking(coordinator, c.id, venue.id);
  expect(fresh.status).toBe("Requested");

  await expectRefused(approveVenueBooking(venueStaff, requestA.id), 409);
  expect((await fetchEventBookings(coordinator, a.id))[0].status).toBe("Expired");
});
