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
  await expect(page).toHaveURL(session.landingPath);
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
