import { expect, test } from "@playwright/test";
import {
  climbToSafetyReview,
  expectRefused,
  fetchSafetyChanges,
  getEvent,
  rejectSafetyReview,
  releaseVenueBooking,
  requestSafetyChanges,
} from "./support/backend";

/**
 * E3-13 / E3-14 (AGENTS.md §3): the two Safety Officer outcomes other than
 * approval both send the event back to Planning. "Request changes" must name
 * at least one of this event's arrangements with a note on each; those are
 * flagged for the coordinator, and a flag clears once its arrangement no
 * longer matches (here: the booking is released).
 */

test.describe.configure({ timeout: 90_000 });

test("requesting changes flags the named booking, returns the event to Planning, and the flag clears once it's addressed", async () => {
  const { event, coordinator, safetyOfficer, booking } = await climbToSafetyReview("safety-changes");
  const note = "Fire exit is blocked by the stage in this room.";

  const back = await requestSafetyChanges(
    safetyOfficer,
    event.id,
    [{ type: "venue_booking", id: booking.id, note }],
    "Please also confirm the stewarding plan.",
  );
  expect(back.status).toBe("Planning");

  const changes = await fetchSafetyChanges(coordinator, event.id);
  expect(changes).not.toBeNull();
  expect(changes!.generalNote).toBe("Please also confirm the stewarding plan.");
  expect(changes!.flags).toEqual([
    expect.objectContaining({ type: "venue_booking", id: booking.id, note, clearedAt: null }),
  ]);

  // The coordinator gives the room up; the flag on it no longer applies.
  await releaseVenueBooking(coordinator, booking.id);
  const after = await fetchSafetyChanges(coordinator, event.id);
  expect(after!.flags[0].clearedAt).not.toBeNull();
});

test("requesting changes is refused without an arrangement, without a note, or for another event's booking", async () => {
  const [mine, other] = await Promise.all([
    climbToSafetyReview("safety-changes-invalid"),
    climbToSafetyReview("safety-changes-other"),
  ]);
  const { event, safetyOfficer, booking, organiser } = mine;

  await expectRefused(requestSafetyChanges(safetyOfficer, event.id, []), 400);
  await expectRefused(
    requestSafetyChanges(safetyOfficer, event.id, [{ type: "venue_booking", id: booking.id, note: " " }]),
    400,
  );
  await expectRefused(
    requestSafetyChanges(safetyOfficer, event.id, [
      { type: "venue_booking", id: other.booking.id, note: "Not this event's." },
    ]),
    400,
  );

  // None of those changed anything.
  expect((await getEvent(organiser, event.id)).status).toBe("Safety Review");
});

test("rejecting the safety arrangement needs a reason and returns the event to Planning", async () => {
  const { event, organiser, safetyOfficer } = await climbToSafetyReview("safety-reject");

  await expectRefused(rejectSafetyReview(safetyOfficer, event.id, ""), 400);
  expect((await getEvent(organiser, event.id)).status).toBe("Safety Review");

  const back = await rejectSafetyReview(safetyOfficer, event.id, "Crowd plan exceeds the room's fire limit.");
  expect(back.status).toBe("Planning");
});
