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
