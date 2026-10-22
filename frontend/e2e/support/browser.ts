import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { Session } from "./backend";

/**
 * Drives the real login form — the one UI interaction every test that
 * needs a session should use rather than seeding localStorage directly, so
 * the form itself stays covered by at least one real exercise per role.
 * Setup for everything *after* login (creating events, bookings, etc.)
 * goes through backend.ts's API calls instead.
 */
export async function logIn(page: Page, session: Session): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(session.email);
  await page.getByLabel("Password", { exact: true }).fill(session.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Pathname only: a landing view may append its own default query shortly
  // after mount (e.g. VenueStaff.vue adding ?venue=&date=&tab=), which is
  // that component's own state, not part of what the login redirect itself
  // decided. An exact match races that append and is flaky by design.
  await expect(page).toHaveURL(landingPathPattern(session.landingPath));
}

/**
 * Matches `path`, optionally followed by a query string — for asserting a
 * redirect landed on the right page without caring about query params a
 * component appends on its own shortly after mount (see logIn above).
 */
export function landingPathPattern(path: string): RegExp {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(\\?.*)?$`);
}

/**
 * Skips the login form by writing the session straight into localStorage,
 * the same keys auth.ts itself uses. For tests whose subject isn't the
 * login flow and that would otherwise pay its cost in every single test.
 */
export async function signInThroughStorage(page: Page, session: Session): Promise<void> {
  await page.addInitScript(
    ({ token, user }) => {
      window.localStorage.setItem("auth_token", token);
      window.localStorage.setItem("auth_user", JSON.stringify(user));
    },
    { token: session.token, user: session.user },
  );
}

/**
 * Asserts the event page shows `status` as the current step of its progress
 * tracker. Not a bare getByText(status): the page repeats the status in more
 * than one badge as well as the tracker, so text alone matches several
 * elements. aria-current marks exactly the one step the event is on.
 */
export async function expectEventStatus(page: Page, status: string): Promise<void> {
  const current = page.getByRole("list", { name: "Event progress" }).locator('[aria-current="step"]');
  await expect(current.locator(".status-tracker__label")).toHaveText(status);
}
