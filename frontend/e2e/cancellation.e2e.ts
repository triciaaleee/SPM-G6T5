import { expect, test } from "@playwright/test";
import {
  climbToConfirmed,
  fetchEventBookings,
  fetchEventRegistrations,
  fetchMyNotifications,
  getEvent,
  openRegistrationToday,
  registerAttendee,
  registerForEvent,
} from "./support/backend";
import { logIn } from "./support/browser";

/**
 * E3-6 (AGENTS.md §3, "Cancelling an event"): the organiser cancels a
 * Confirmed event with a required reason. That's one write in events-service,
 * but the rest happens elsewhere, asynchronously, off the event.cancelled
 * message on RabbitMQ: venue-service releases every booking, registration-
 * service cancels every registration, and notification-service tells the
 * coordinator (with the reason) and every registered attendee. Only a test
 * across the real services can see all of that happen.
 */

test("organiser cancels a Confirmed event; bookings, registrations and notifications all follow", async ({ page }) => {
  test.setTimeout(90_000);
  const { event, organiser, coordinator } = await climbToConfirmed("cancel", {
    registrationNeeded: true,
  });
  await openRegistrationToday(coordinator, event.id);
  const attendee = await registerAttendee("cancel-attendee");
  await registerForEvent(attendee, event.id);

  await logIn(page, organiser);
  await page.goto(`/events/${event.id}`);
  await page.getByRole("button", { name: "Cancel event" }).click();

  // The reason is required: nothing can be confirmed until one is given.
  const dialog = page.getByRole("alertdialog", { name: "Cancel this event?" });
  const confirm = dialog.getByRole("button", { name: "Confirm cancellation" });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/reason/i).fill("   ");
  await expect(confirm).toBeDisabled();

  const reason = "Speaker withdrew at short notice.";
  await dialog.getByLabel(/reason/i).fill(reason);
  await confirm.click();
  await expect(page.getByText(`This event was cancelled: "${reason}"`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel event" })).toHaveCount(0);

  expect((await getEvent(organiser, event.id)).status).toBe("Cancelled");

  const consumed = {
    message: "waiting for event.cancelled to be consumed",
    timeout: 15_000,
  };

  // venue-service released the booking (Withdrawn, the row kept for history).
  await expect
    .poll(async () => (await fetchEventBookings(coordinator, event.id)).map((b) => b.status), consumed)
    .toEqual(["Withdrawn"]);

  // registration-service cancelled the attendee's place (not Withdrawn: they didn't give it up).
  await expect
    .poll(async () => (await fetchEventRegistrations(organiser, event.id)).map((r) => r.status), consumed)
    .toEqual(["Cancelled"]);

  // The attendee and the coordinator were both told, the coordinator with the reason.
  await expect
    .poll(
      async () =>
        (await fetchMyNotifications(attendee)).some(
          (n) => n.eventId === event.id && n.type === "registration.cancelled_by_event",
        ),
      consumed,
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await fetchMyNotifications(coordinator, 50)).some(
          (n) => n.eventId === event.id && n.type === "event.cancelled" && n.body.includes(reason),
        ),
      consumed,
    )
    .toBe(true);
});
