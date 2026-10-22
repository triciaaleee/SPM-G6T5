import { expect, test } from "@playwright/test";
import {
  deleteDraft,
  editEvent,
  eventDetails,
  expectRefused,
  getEvent,
  registerOrganiser,
  saveDraft,
  signInAsCoordinator,
  signInAsCoordinatorLead,
} from "./support/backend";
import { logIn } from "./support/browser";

/**
 * E2-4 (AGENTS.md §3): a draft is the organiser's unfinished work and sits
 * outside the lifecycle. It skips validation until submitted, nobody but its
 * organiser can see it, and its only way out is being submitted into
 * Unassigned (or deleted).
 */

test("saving a draft from the form skips validation and lands it on the Drafts tab", async ({ page }) => {
  const organiser = await registerOrganiser("draft-form");

  await logIn(page, organiser);
  await page.goto("/events/new");
  const name = `Half-finished idea ${Date.now()}`;
  await page.getByLabel("Event name").fill(name);
  await page.getByRole("button", { name: "Save as Draft" }).click();

  await expect(page).toHaveURL(/tab=drafts/);
  await expect(page.getByText(name)).toBeVisible();
});

test("only its organiser can see a draft — not a coordinator, not the Lead", async () => {
  const organiser = await registerOrganiser("draft-private");
  const [coordinator, lead] = await Promise.all([signInAsCoordinator(), signInAsCoordinatorLead()]);
  const draft = await saveDraft(organiser, { name: "Not ready yet" });
  expect(draft.status).toBe("Draft");

  expect((await getEvent(organiser, draft.id)).status).toBe("Draft");
  await expectRefused(getEvent(coordinator, draft.id), 403);
  await expectRefused(getEvent(lead, draft.id), 403);
});

test("submitting a draft validates it, then moves it into Unassigned", async () => {
  const organiser = await registerOrganiser("draft-submit");
  const draft = await saveDraft(organiser, { name: "Missing most fields" });

  await expectRefused(editEvent(organiser, draft.id, { name: "Missing most fields" }), 400);
  expect((await getEvent(organiser, draft.id)).status).toBe("Draft");

  const submitted = await editEvent(organiser, draft.id, eventDetails());
  expect(submitted.status).toBe("Unassigned");

  // It has left Draft for good: it can't be deleted as a draft any more.
  await expectRefused(deleteDraft(organiser, draft.id), 409);
});

test("a deleted draft is gone, and only its organiser can delete it", async () => {
  const organiser = await registerOrganiser("draft-delete");
  const stranger = await registerOrganiser("draft-delete-stranger");
  const draft = await saveDraft(organiser, { name: "Scrap this" });

  await expectRefused(deleteDraft(stranger, draft.id), 403);
  await deleteDraft(organiser, draft.id);
  await expectRefused(getEvent(organiser, draft.id), 403);
});
