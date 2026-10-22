import { expect, test } from "@playwright/test";
import {
  approveRequest,
  approveVenueBooking,
  assignCoordinator,
  cancelEvent,
  catalogItem,
  climbToConfirmed,
  expectRefused,
  fetchEventEquipment,
  fetchMyVenues,
  listEquipmentCatalog,
  registerOrganiser,
  requestEquipment,
  requestVenueBooking,
  setEquipmentRequestStatus,
  signInAsCoordinator,
  signInAsCoordinatorLead,
  signInAsTechnicalSupport,
  signInAsVenueStaff,
  submitEvent,
  submitForSafetyReview,
  uniqueFutureDate,
} from "./support/backend";

/**
 * E5-3 / E5-6 / E3-4 / E3-6: equipment is recorded by the coordinator,
 * reserved by Technical Support (which takes it out of stock), required
 * before safety review, and returned to stock when the event is cancelled.
 *
 * Each test reserves from a different catalog item so parallel tests never
 * move the same stock count; equipment.e2e.ts only records requests, never
 * reserves, so it doesn't move stock either.
 */

test.describe.configure({ timeout: 90_000 });

async function catalogItemAt(index: number) {
  const techSupport = await signInAsTechnicalSupport();
  const catalog = await listEquipmentCatalog(techSupport);
  expect(catalog.length, "the seed has several catalog items").toBeGreaterThan(index);
  return { techSupport, item: catalog[index] };
}

test("safety review waits for equipment to be reserved; reserving takes it out of stock", async () => {
  const { techSupport, item } = await catalogItemAt(1);
  const organiser = await registerOrganiser("equip-reserve");
  const [coordinator, lead, venueStaff] = await Promise.all([
    signInAsCoordinator(),
    signInAsCoordinatorLead(),
    signInAsVenueStaff(),
  ]);
  const event = await submitEvent(organiser, { proposedDate: uniqueFutureDate() });
  await assignCoordinator(lead, event.id, coordinator.id);
  await approveRequest(coordinator, event.id);
  const [venue] = await fetchMyVenues(venueStaff);
  await approveVenueBooking(venueStaff, (await requestVenueBooking(coordinator, event.id, venue.id)).id);

  const request = await requestEquipment(coordinator, event.id, [{ equipmentCatalogId: item.id, quantity: 3 }]);

  // E3-4: the venue is confirmed, but the equipment isn't reserved yet.
  const blocked = await expectRefused(submitForSafetyReview(coordinator, event.id), 409);
  expect(blocked.body).toMatchObject({ outstanding: expect.anything() });

  const before = (await catalogItem(techSupport, item.id)).availableStock;
  const arranged = await setEquipmentRequestStatus(techSupport, request.id, "Arranged");
  expect(arranged.items[0].quantityFulfilled).toBe(3);
  expect((await catalogItem(techSupport, item.id)).availableStock).toBe(before - 3);

  expect((await submitForSafetyReview(coordinator, event.id)).status).toBe("Safety Review");
});

test("reserving more than is in stock is refused and takes nothing", async () => {
  const { techSupport, item } = await catalogItemAt(2);
  const organiser = await registerOrganiser("equip-too-many");
  const [coordinator, lead] = await Promise.all([signInAsCoordinator(), signInAsCoordinatorLead()]);
  const event = await submitEvent(organiser, { proposedDate: uniqueFutureDate() });
  await assignCoordinator(lead, event.id, coordinator.id);
  await approveRequest(coordinator, event.id);

  const before = await catalogItem(techSupport, item.id);
  const request = await requestEquipment(coordinator, event.id, [
    { equipmentCatalogId: item.id, quantity: before.totalStock + 1 },
  ]);

  await expectRefused(setEquipmentRequestStatus(techSupport, request.id, "Arranged"), 409);
  expect((await catalogItem(techSupport, item.id)).availableStock).toBe(before.availableStock);
  expect((await fetchEventEquipment(techSupport, event.id))[0].items[0].quantityFulfilled).toBe(0);
});

test("cancelling an event returns its reserved equipment to stock", async () => {
  const { techSupport, item } = await catalogItemAt(3);
  const before = (await catalogItem(techSupport, item.id)).availableStock;

  const { event, organiser } = await climbToConfirmed("equip-cancel", {}, async ({ event, coordinator }) => {
    const request = await requestEquipment(coordinator, event.id, [{ equipmentCatalogId: item.id, quantity: 2 }]);
    await setEquipmentRequestStatus(techSupport, request.id, "Arranged");
  });
  expect((await catalogItem(techSupport, item.id)).availableStock).toBe(before - 2);

  await cancelEvent(organiser, event.id, "Funding fell through.");

  // equipment-service releases it off the event.cancelled message, asynchronously.
  await expect
    .poll(async () => (await catalogItem(techSupport, item.id)).availableStock, {
      message: "waiting for equipment-service to release the reservation",
      timeout: 15_000,
    })
    .toBe(before);
  expect((await fetchEventEquipment(techSupport, event.id))[0].items[0].quantityFulfilled).toBe(0);
});
