import { expect, test } from "@playwright/test";
import {
  registerAttendee,
  registerOrganiser,
  signInAsCoordinator,
  signInAsCoordinatorLead,
  signInAsSafetyOfficer,
  signInAsVenueStaff,
  signInAsTechnicalSupport,
} from "./support/backend";
import { logIn } from "./support/browser";

test.describe("Login lands every role on its own page", () => {
  test("organiser lands on the events list", async ({ page }) => {
    const session = await registerOrganiser("login-organiser");
    await logIn(page, session);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("attendee lands on their registered events", async ({ page }) => {
    const session = await registerAttendee("login-attendee");
    await logIn(page, session);
    await expect(page).toHaveURL("/attendee/events");
  });

  test("coordinator lands on their workload view", async ({ page }) => {
    const session = await signInAsCoordinator();
    await logIn(page, session);
    await expect(page).toHaveURL("/coordinator");
  });

  test("coordinator_lead lands on the lead dashboard", async ({ page }) => {
    const session = await signInAsCoordinatorLead();
    await logIn(page, session);
    await expect(page).toHaveURL("/lead");
  });

  test("venue_staff lands on their schedule", async ({ page }) => {
    const session = await signInAsVenueStaff();
    await logIn(page, session);
    await expect(page).toHaveURL("/venue-schedule");
  });

  test("technical_support lands on the equipment request queue", async ({ page }) => {
    const session = await signInAsTechnicalSupport();
    await logIn(page, session);
    await expect(page).toHaveURL("/equipment-requests");
  });

  test("safety_officer lands on the safety review queue", async ({ page }) => {
    const session = await signInAsSafetyOfficer();
    await logIn(page, session);
    await expect(page).toHaveURL("/safety-review");
  });
});

test("a wrong password is rejected with a generic error, not a field-specific one", async ({ page }) => {
  const session = await registerOrganiser("login-wrong-password");
  await page.goto("/login");
  await page.getByLabel("Email").fill(session.email);
  await page.getByLabel("Password", { exact: true }).fill("not-the-real-password");
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page.getByRole("alert")).toHaveText(/invalid email or password/i);
  await expect(page).toHaveURL("/login");
});

test("visiting a protected route while signed out redirects to login", async ({ page }) => {
  await page.goto("/coordinator");
  await expect(page).toHaveURL(/\/login/);
});

test("signing in already-authenticated and visiting /login redirects to the role's landing page", async ({
  page,
}) => {
  const session = await registerOrganiser("login-already-authed");
  await logIn(page, session);
  await page.goto("/login");
  await expect(page).toHaveURL("/");
});
