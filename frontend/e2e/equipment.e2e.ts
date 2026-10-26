import { expect, test } from "@playwright/test";
import {
  approveRequest,
  assignCoordinator,
  listEquipmentCatalog,
  registerOrganiser,
  signInAsCoordinator,
  signInAsCoordinatorLead,
  signInAsTechnicalSupport,
  submitEvent,
  uniqueName,
} from "./support/backend";
import { signInThroughStorage } from "./support/browser";

/**
 * E5-1: while an event is in Planning, its assigned coordinator records
 * equipment requirements through the real form in EquipmentRequestPanel
 * (not the API), and Technical Support then sees it in their queue
 * (/equipment-requests) and on the event's own request detail page.
 */

test("coordinator records equipment requirements via the form; Technical Support sees the request", async ({
  page,
}) => {
  const organiser = await registerOrganiser("equipment-organiser");
  const coordinator = await signInAsCoordinator();
  const lead = await signInAsCoordinatorLead();
  const techSupport = await signInAsTechnicalSupport();

  const eventName = uniqueName("Equipment Event");
  const event = await submitEvent(organiser, { name: eventName });
  await assignCoordinator(lead, event.id, coordinator.id);
  await approveRequest(coordinator, event.id); // Requested -> Planning

  const catalog = await listEquipmentCatalog(coordinator);
  expect(catalog.length).toBeGreaterThan(0);
  const item = catalog[0];

  // Coordinator drives the real Equipment Requirements form, which sits on
  // the event page's Arrangements tab.
  await signInThroughStorage(page, coordinator);
  await page.goto(`/events/${event.id}`);
  await page.getByRole("button", { name: /^Arrangements/ }).click();
  await page.getByRole("button", { name: "Add Equipment Request" }).click();

  await page.getByLabel("Equipment type").selectOption(String(item.id));
  await page.getByLabel("Quantity").fill("2");
  await page.getByRole("button", { name: /submit request/i }).click();

  await expect(page.getByText(/equipment request submitted/i)).toBeVisible();
  // The panel lists items in a table: name in one column, quantity in another.
  const itemRow = page.locator("li.row-item", { hasText: item.name }).first();
  await expect(itemRow).toBeVisible();
  await expect(itemRow).toContainText("2");

  // Technical Support sees it in their queue, grouped under this event.
  // backend.ts's default eventDetails() proposedDate is 2099-09-24 (safely
  // in the future for every test that doesn't care about the date), which
  // falls outside this queue's default "Next 30 days" filter — switch to
  // "All dates" rather than relying on a near-future date no test asserts on.
  await signInThroughStorage(page, techSupport);
  await page.goto("/equipment-requests");
  await page.getByLabel("Date range").selectOption({ label: "All dates" });
  // The queue opens on its first non-empty status tab as judged by the
  // default date range, which this 2099 event falls outside of, so it may
  // open on another tab. A new request is always under Requested.
  await page.getByRole("tab", { name: /^Requested/ }).click();
  await expect(page.getByRole("heading", { name: eventName, level: 2 })).toBeVisible();

  // And on the event's own equipment request detail page. Quantity and name
  // render as separate table cells (DataTable's "qty"/"equipment" columns),
  // not as one combined text node, so check each cell within the item's row.
  await page.getByRole("heading", { name: eventName, level: 2 }).click();
  await expect(page).toHaveURL(new RegExp(`/equipment-requests/event/${event.id}$`));
  const detailRow = page.locator("li.row-item", { hasText: item.name }).first();
  await expect(detailRow).toBeVisible();
  await expect(detailRow.locator(".item-name")).toHaveText(item.name);
  await expect(detailRow.locator(".item-qty").first()).toHaveText("2×");
});
