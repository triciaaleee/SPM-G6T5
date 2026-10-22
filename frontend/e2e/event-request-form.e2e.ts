import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { getEvent, registerOrganiser, signInAsCoordinatorLead, uniqueFutureDate, uniqueName } from "./support/backend";
import { logIn, signInThroughStorage } from "./support/browser";

/**
 * E2-1: the organiser's own way into the whole lifecycle, driven through
 * the real form rather than the API every other test uses for setup. A
 * submitted request lands in Unassigned (AGENTS.md §3, Week 7 change 5),
 * and in the Lead's unassigned queue; an invalid one creates nothing.
 */

async function fillValidRequest(page: Page, name: string): Promise<void> {
  await page.getByLabel("Event name").fill(name);
  await page.getByLabel("Purpose").fill("End-to-end form coverage");
  await page.getByLabel("Description").fill("Submitted through the real form by the e2e suite.");
  await page.getByLabel("Proposed date").fill(uniqueFutureDate());
  await page.getByLabel("Start time").fill("10:00");
  await page.getByLabel("End time").fill("12:00");
  await page.getByLabel("Expected attendance").fill("40");
  await page.getByLabel("Venue Requirements").fill("A room for 40");
  await page.getByLabel("Accessibility").fill("NA");
  await page.getByLabel("Equipment").fill("NA");
  await page.getByLabel("Technical support").fill("NA");
}

test("organiser submits a request through the form; it lands in Unassigned and in the Lead's queue", async ({
  page,
}) => {
  const organiser = await registerOrganiser("form-organiser");
  const lead = await signInAsCoordinatorLead();
  const name = uniqueName("Form Event");

  await logIn(page, organiser);
  await page.goto("/events/new");
  await fillValidRequest(page, name);
  await page.getByRole("button", { name: "Submit request" }).click();

  await expect(page.getByText("Request submitted")).toBeVisible();
  await expect(page.getByText(/created with status\s+Unassigned/)).toBeVisible();

  await page.getByRole("link", { name: "View request" }).click();
  await expect(page).toHaveURL(/\/events\/\d+$/);
  const eventId = Number(new URL(page.url()).pathname.split("/").pop());
  await expect(page.getByText(name).first()).toBeVisible();

  // What the backend actually stored, not just what the page says.
  const stored = await getEvent(organiser, eventId);
  expect(stored.status).toBe("Unassigned");
  expect(stored.coordinator_id).toBeNull();
  expect(stored.submitted_details).toMatchObject({
    name,
    expectedAttendance: 40,
    startTime: "10:00",
  });

  await signInThroughStorage(page, lead);
  await page.goto("/lead/unassigned");
  await expect(page.getByText(name)).toBeVisible();
});

test("submitting an empty form shows required-field errors and creates nothing", async ({ page }) => {
  const organiser = await registerOrganiser("form-empty-organiser");

  await logIn(page, organiser);
  await page.goto("/events/new");
  await page.getByRole("button", { name: "Submit request" }).click();

  await expect(page.getByText("This field is required.").first()).toBeVisible();
  await expect(page.getByText("Request submitted")).toHaveCount(0);
  await expect(page).toHaveURL(/\/events\/new$/);
});

test("an end time before the start time is refused with a message on the end time", async ({ page }) => {
  const organiser = await registerOrganiser("form-times-organiser");

  await logIn(page, organiser);
  await page.goto("/events/new");
  await fillValidRequest(page, uniqueName("Backwards Times Event"));
  await page.getByLabel("Start time").fill("14:00");
  await page.getByLabel("End time").fill("13:00");
  await page.getByRole("button", { name: "Submit request" }).click();

  await expect(page.getByText("End time must be after the start time.")).toBeVisible();
  await expect(page.getByText("Request submitted")).toHaveCount(0);
});
