import { expect, test } from "@playwright/test";
import {
  approveRequest,
  approveVenueBooking,
  assignCoordinator,
  catalogItem,
  fetchEventBookings,
  fetchEventEquipment,
  fetchEventHistory,
  fetchMyNotifications,
  fetchMyVenues,
  getEvent,
  listEquipmentCatalog,
  registerOrganiser,
  rejectRequest,
  requestClarification,
  requestEquipment,
  requestVenueBooking,
  setEquipmentRequestStatus,
  signInAsCoordinator,
  signInAsCoordinatorLead,
  signInAsTechnicalSupport,
  signInAsVenueStaff,
  submitEvent,
  uniqueFutureDate,
} from "./support/backend";

/**
 * AGENTS.md §3, `Clarification Requested -> Rejected`: a `Planning` event that
 * is sent for clarification can be rejected, and by then it may already hold
 * an approved venue booking and reserved equipment. Rejecting is one write in
 * events-service, but venue-service and equipment-service release what the
 * event holds off the event.rejected message on RabbitMQ, asynchronously.
 *
 * Reserves from its own catalog item (index 5) so parallel tests never move
 * the same stock count (see equipment-reservation.e2e.ts).
 */

test("rejecting a Planning event through a clarification releases its venue booking and equipment", async () => {
  test.setTimeout(90_000);
  const techSupport = await signInAsTechnicalSupport();
  const catalog = await listEquipmentCatalog(techSupport);
  expect(catalog.length, "the seed has several catalog items").toBeGreaterThan(5);
  const item = catalog[5];
  const date = uniqueFutureDate();
  const before = (await catalogItem(techSupport, item.id, date)).availableStock;

  const organiser = await registerOrganiser("reject-releases");
  const [coordinator, lead, venueStaff] = await Promise.all([
    signInAsCoordinator(),
    signInAsCoordinatorLead(),
    signInAsVenueStaff(),
  ]);
  const event = await submitEvent(organiser, { proposedDate: date });
  await assignCoordinator(lead, event.id, coordinator.id);
  await approveRequest(coordinator, event.id);

  // An approved venue booking and a reserved equipment request, both held by the Planning event.
  const venues = await fetchMyVenues(venueStaff);
  const venue = venues[Math.floor(Math.random() * venues.length)];
  const requested = await requestVenueBooking(coordinator, event.id, venue.id);
  await approveVenueBooking(venueStaff, requested.id);
  const request = await requestEquipment(coordinator, event.id, [{ equipmentCatalogId: item.id, quantity: 2 }]);
  await setEquipmentRequestStatus(techSupport, request.id, "Arranged");
  expect((await catalogItem(techSupport, item.id, date)).availableStock).toBe(before - 2);
  expect((await fetchEventBookings(coordinator, event.id)).map((b) => b.status)).toEqual(["Approved"]);

  // The coordinator asks a question; the answer shows the event can't go ahead, so it is rejected.
  expect((await requestClarification(coordinator, event.id, "Can this move to another week?")).status).toBe(
    "Clarification Requested",
  );
  const reason = "No suitable week is free, so the event cannot go ahead.";
  expect((await rejectRequest(coordinator, event.id, reason)).status).toBe("Rejected");
  expect((await getEvent(organiser, event.id)).status).toBe("Rejected");

  const consumed = { message: "waiting for event.rejected to be consumed", timeout: 15_000 };

  // venue-service withdrew the booking (the row stays for history), and told the venue's staff member.
  await expect
    .poll(async () => (await fetchEventBookings(coordinator, event.id)).map((b) => b.status), consumed)
    .toEqual(["Withdrawn"]);
  await expect
    .poll(
      async () =>
        (await fetchMyNotifications(venueStaff, 50)).some(
          (n) => n.eventId === event.id && n.type === "booking.withdrawn" && n.body.includes("was rejected"),
        ),
      consumed,
    )
    .toBe(true);

  // equipment-service returned the units to stock.
  await expect
    .poll(async () => (await catalogItem(techSupport, item.id, date)).availableStock, consumed)
    .toBe(before);
  expect((await fetchEventEquipment(techSupport, event.id))[0].items[0].quantityFulfilled).toBe(0);

  // The rejection and its reason are in the history, since the decision columns were overwritten.
  const history = await fetchEventHistory(coordinator, event.id);
  expect(history.some((h) => h.field === "Status" && h.old_value === "Clarification Requested" && h.new_value === "Rejected")).toBe(true);
  expect(history.some((h) => h.field === "Rejection reason" && h.new_value === reason)).toBe(true);
});
