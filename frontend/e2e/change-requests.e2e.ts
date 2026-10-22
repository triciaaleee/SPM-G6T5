import { expect, test } from "@playwright/test";
import {
  approveChangeRequest,
  climbToConfirmed,
  expectRefused,
  getEvent,
  raiseChangeRequest,
  registerOrganiser,
  rejectChangeRequest,
  submitEvent,
  submitForSafetyReview,
} from "./support/backend";

/**
 * E3-8 / E3-9 / E3-11 (AGENTS.md §3, "Who can edit an event's details"):
 * once Confirmed, the organiser can't edit directly; they raise a change
 * request. Non-critical fields apply at once. Critical ones (date/time,
 * attendance, venue, equipment, accessibility) are held for the coordinator
 * and move the event to Needs Review. Rejecting them returns it straight to
 * Confirmed; approving them applies the change and the event needs a fresh
 * safety review before it is Confirmed again.
 */

test.describe.configure({ timeout: 90_000 });

test("a non-critical change applies at once and the event stays Confirmed", async () => {
  const { event, organiser } = await climbToConfirmed("cr-noncritical");

  const result = await raiseChangeRequest(organiser, event.id, { purpose: "Now also a fundraiser" });
  expect(result.applied).toEqual(["purpose"]);
  expect(result.held).toEqual([]);

  const after = await getEvent(organiser, event.id);
  expect(after.status).toBe("Confirmed");
  expect(after.submitted_details).toMatchObject({ purpose: "Now also a fundraiser" });
});

test("a critical change is held, moves the event to Needs Review, and a rejection restores Confirmed unchanged", async () => {
  const { event, organiser, coordinator } = await climbToConfirmed("cr-critical-reject");
  const before = event.submitted_details.accessibility;

  const result = await raiseChangeRequest(organiser, event.id, { accessibility: "Step-free access to the stage" });
  expect(result.held).toEqual(["accessibility"]);

  const held = await getEvent(organiser, event.id);
  expect(held.status).toBe("Needs Review");
  expect(held.submitted_details.accessibility).toBe(before); // not applied while held

  await expectRefused(rejectChangeRequest(coordinator, event.id, result.changeRequestId, " "), 400);
  await rejectChangeRequest(coordinator, event.id, result.changeRequestId, "The stage can't be made step-free.");

  const after = await getEvent(organiser, event.id);
  expect(after.status).toBe("Confirmed");
  expect(after.submitted_details.accessibility).toBe(before);
});

test("approving a critical change applies it, and the event must pass safety review again", async () => {
  const { event, organiser, coordinator } = await climbToConfirmed("cr-critical-approve");

  const { changeRequestId } = await raiseChangeRequest(organiser, event.id, { accessibility: "Hearing loop needed" });
  await approveChangeRequest(coordinator, event.id, changeRequestId);

  const after = await getEvent(organiser, event.id);
  expect(after.submitted_details.accessibility).toBe("Hearing loop needed");
  // The Safety Officer's earlier approval no longer holds, so it doesn't go straight back to Confirmed.
  expect(after.status).toBe("Needs Review");

  expect((await submitForSafetyReview(coordinator, event.id)).status).toBe("Safety Review");
});

test("change requests are refused before Confirmed and from anyone but the owner", async () => {
  const { event } = await climbToConfirmed("cr-not-owner");
  const stranger = await registerOrganiser("cr-stranger");
  await expectRefused(raiseChangeRequest(stranger, event.id, { purpose: "Not mine" }), 403);

  const owner = await registerOrganiser("cr-too-early");
  const early = await submitEvent(owner);
  await expectRefused(raiseChangeRequest(owner, early.id, { purpose: "Edit it directly instead" }), 409);
});
