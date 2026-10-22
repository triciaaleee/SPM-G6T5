import { expect, test } from "@playwright/test";
import {
  cancelEvent,
  climbToConfirmed,
  completeEvent,
  expectRefused,
  fetchEventBookings,
  getEvent,
  signInAsSeeded,
  SEEDED_ACCOUNTS,
} from "./support/backend";
import { timeTravel } from "./support/database";

/**
 * E3-5 (AGENTS.md §3, Confirmed -> Completed): the assigned coordinator marks
 * an event completed by hand, only once it has ended (Singapore time).
 * Completed is terminal, and nothing is released: its bookings stay as they
 * were, for the record.
 */

test.describe.configure({ timeout: 90_000 });

test("an event can't be completed before it ends", async () => {
  const { event, organiser, coordinator } = await climbToConfirmed("complete-early");

  await expectRefused(completeEvent(coordinator, event.id), 409);
  expect((await getEvent(organiser, event.id)).status).toBe("Confirmed");
});

test("once it has ended, only its coordinator can complete it; it's then terminal and keeps its booking", async () => {
  test.skip(!timeTravel, "needs the local throwaway database (see e2e/README.md)");
  const { event, organiser, coordinator, booking } = await climbToConfirmed("complete-after");
  await timeTravel!.moveEventToYesterday(event.id);

  const other = await signInAsSeeded(SEEDED_ACCOUNTS.coordinatorTwo);
  await expectRefused(completeEvent(other, event.id), 403);

  expect((await completeEvent(coordinator, event.id)).status).toBe("Completed");

  // Terminal: no completing twice, no cancelling afterwards.
  await expectRefused(completeEvent(coordinator, event.id), 409);
  await expectRefused(cancelEvent(organiser, event.id, "Too late."), 409);

  // Nothing released: the venue booking is still on record as Approved.
  const [kept] = (await fetchEventBookings(coordinator, event.id)).filter((b) => b.id === booking.id);
  expect(kept.status).toBe("Approved");
});
