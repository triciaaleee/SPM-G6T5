import { expect, test } from "@playwright/test";
import {
  climbToConfirmed,
  fetchPublicEvents,
  openRegistrationToday,
  submitEvent,
  registerOrganiser,
  uniqueName,
} from "./support/backend";

/**
 * The guest pages (/explore/*): a signed-out visitor sees only events that
 * are Confirmed with registration opened — the same rule attendees get —
 * and nothing about any other event. Registering needs an account, so the
 * register action sends them to sign up and back.
 */

test.describe.configure({ timeout: 90_000 });

test("a guest sees an open event and is sent to sign up to register; unlisted events stay hidden", async ({ page }) => {
  const listedName = uniqueName("Public Open Event");
  const { event: listed, coordinator } = await climbToConfirmed("public-listed", {
    name: listedName,
    registrationNeeded: true,
  });
  await openRegistrationToday(coordinator, listed.id);
  const { event: notOpened } = await climbToConfirmed("public-unopened", { registrationNeeded: true });
  const pending = await submitEvent(await registerOrganiser("public-pending"), { name: uniqueName("Public Pending") });

  const publicIds = (await fetchPublicEvents()).map((e) => e.id);
  expect(publicIds).toContain(listed.id);
  expect(publicIds).not.toContain(notOpened.id);
  expect(publicIds).not.toContain(pending.id);

  await page.goto("/explore/events");
  await page.getByText(listedName).first().click();
  await expect(page).toHaveURL(new RegExp(`/explore/events/${listed.id}$`));
  await page.getByRole("link", { name: "Sign up to register" }).click();
  await expect(page).toHaveURL(/\/signup\?redirect=/);

  // A request that isn't public looks exactly like one that doesn't exist.
  await page.goto(`/explore/events/${pending.id}`);
  await expect(page.getByRole("heading", { name: "This event isn't available" })).toBeVisible();
});

test("a signed-out visitor can browse venues without an account", async ({ page }) => {
  await page.goto("/explore/venues");
  await expect(page.getByRole("heading", { name: /Venues/, level: 1 })).toBeVisible();
  await expect(page.getByText("Black Box Studio").first()).toBeVisible();
  await expect(page).toHaveURL(/\/explore\/venues$/);
});
