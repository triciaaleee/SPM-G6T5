import { expect, test } from "@playwright/test";
import {
  assignCoordinator,
  fetchMyNotifications,
  registerOrganiser,
  signInAsCoordinator,
  signInAsCoordinatorLead,
  submitEvent,
  uniqueName,
  type NotificationRow,
} from "./support/backend";
import { signInThroughStorage } from "./support/browser";

/**
 * E2-13 (AGENTS.md §3): the Lead assigning a coordinator notifies that
 * coordinator (and the Organiser). This proves one concrete, real
 * notification end to end.
 *
 * The notification isn't written by events-service's own request handler —
 * it's published to RabbitMQ (ARD section 1.1) and turned into a row by
 * notification-service's own consumer, asynchronously. So finding it is a
 * genuine wait, not a one-shot read: `expect.poll` retries the lookup until
 * the consumer has caught up (or its own timeout elapses), which is the
 * correct way to wait out this race rather than a fixed sleep.
 */

test("Lead assigning a coordinator notifies that coordinator, visible in their feed", async ({ page }) => {
  const organiser = await registerOrganiser("notif-organiser");
  const coordinator = await signInAsCoordinator();
  const lead = await signInAsCoordinatorLead();

  const eventName = uniqueName("Notify Me Event");
  const event = await submitEvent(organiser, { name: eventName });

  const assigned = await assignCoordinator(lead, event.id, coordinator.id);
  expect(assigned.status).toBe("Requested");

  let found: NotificationRow | undefined;
  await expect
    .poll(
      async () => {
        const notifications = await fetchMyNotifications(coordinator);
        found = notifications.find((n) => n.eventId === event.id);
        return found !== undefined;
      },
      { message: "waiting for the coordinator.assigned notification to be consumed from RabbitMQ", timeout: 10_000 },
    )
    .toBe(true);

  // No assertion on found.read: this coordinator is a shared seeded account
  // on the dev database, and anyone signed in as it who opens their
  // notification bell marks every notification read, this one included.

  // The same notification shows up in the coordinator's own feed in the
  // browser. The title ("New event assigned to you") is shared by every
  // such notification this seeded coordinator has ever received across
  // test runs, so the match is scoped to this test's own event name, which
  // appears in the notification body.
  await signInThroughStorage(page, coordinator);
  await page.goto("/notifications");
  await expect(page.getByText(eventName)).toBeVisible();
});
