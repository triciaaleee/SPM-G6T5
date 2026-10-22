import { expect, test } from "@playwright/test";
import {
  approveRequest,
  approveSafetyReview,
  assignCoordinator,
  cancelEvent,
  climbToConfirmed,
  editEvent,
  eventDetails,
  expectRefused,
  fetchEventHistory,
  fetchMyNotifications,
  getEvent,
  registerOrganiser,
  reassignCoordinator,
  rejectRequest,
  rejectSafetyReview,
  requestClarification,
  signInAsCoordinator,
  signInAsCoordinatorLead,
  signInAsSafetyOfficer,
  signInAsSeeded,
  SEEDED_ACCOUNTS,
  submitEvent,
  submitForSafetyReview,
} from "./support/backend";

/**
 * AGENTS.md §3: "Validate every transition on the backend ... The frontend
 * may hide invalid actions, but the backend is the source of truth." The UI
 * tests elsewhere only prove the buttons that should exist do work; these
 * prove the real services refuse what the rules forbid, whoever asks.
 */

test.describe("who may act on an event", () => {
  test("another organiser can't read someone else's event", async () => {
    const owner = await registerOrganiser("rules-owner");
    const stranger = await registerOrganiser("rules-stranger");
    const event = await submitEvent(owner);

    await expectRefused(getEvent(stranger, event.id), 403);
  });

  test("a coordinator can't approve before the Lead assigns anyone", async () => {
    const organiser = await registerOrganiser("rules-unassigned");
    const coordinator = await signInAsCoordinator();
    const event = await submitEvent(organiser);

    await expectRefused(approveRequest(coordinator, event.id), 403);
    expect((await getEvent(organiser, event.id)).status).toBe("Unassigned");
  });

  test("only the assigned coordinator can act, not another coordinator", async () => {
    const organiser = await registerOrganiser("rules-mismatch");
    const [assigned, lead] = await Promise.all([signInAsCoordinator(), signInAsCoordinatorLead()]);
    const other = await signInAsSeeded(SEEDED_ACCOUNTS.coordinatorTwo);
    const event = await submitEvent(organiser);
    await assignCoordinator(lead, event.id, assigned.id);

    await expectRefused(approveRequest(other, event.id), 403);
    await expectRefused(rejectRequest(other, event.id, "Not mine to reject."), 403);
    expect((await getEvent(organiser, event.id)).status).toBe("Requested");
  });

  test("another organiser can't cancel someone else's event", async () => {
    const owner = await registerOrganiser("rules-cancel-owner");
    const stranger = await registerOrganiser("rules-cancel-stranger");
    const event = await submitEvent(owner);

    await expectRefused(cancelEvent(stranger, event.id, "Not my event."), 403);
    expect((await getEvent(owner, event.id)).status).toBe("Unassigned");
  });
});

test.describe("illegal transitions are refused", () => {
  test("Planning can't skip Safety Review, and can't be submitted for it without a venue", async () => {
    const organiser = await registerOrganiser("rules-skip");
    const [coordinator, lead, safetyOfficer] = await Promise.all([
      signInAsCoordinator(),
      signInAsCoordinatorLead(),
      signInAsSafetyOfficer(),
    ]);
    const event = await submitEvent(organiser);
    await assignCoordinator(lead, event.id, coordinator.id);
    await approveRequest(coordinator, event.id);

    // No Planning -> Confirmed (AGENTS.md §3: every event must pass Safety Review).
    await expectRefused(approveSafetyReview(safetyOfficer, event.id), 409);
    // E3-4: blocked until every venue booking is confirmed, naming what's outstanding.
    const blocked = await expectRefused(submitForSafetyReview(coordinator, event.id), 409);
    expect(blocked.body).toMatchObject({ outstanding: expect.anything() });

    expect((await getEvent(organiser, event.id)).status).toBe("Planning");
  });

  test("Rejected is terminal: it can't be approved or cancelled afterwards", async () => {
    const organiser = await registerOrganiser("rules-terminal");
    const [coordinator, lead] = await Promise.all([signInAsCoordinator(), signInAsCoordinatorLead()]);
    const event = await submitEvent(organiser);
    await assignCoordinator(lead, event.id, coordinator.id);
    await rejectRequest(coordinator, event.id, "Out of scope for this term.");

    await expectRefused(approveRequest(coordinator, event.id), 409);
    await expectRefused(cancelEvent(organiser, event.id, "Changed my mind."), 409);
    expect((await getEvent(organiser, event.id)).status).toBe("Rejected");
  });

  test("a coordinator can't approve while a clarification is outstanding", async () => {
    const organiser = await registerOrganiser("rules-clarify-block");
    const [coordinator, lead] = await Promise.all([signInAsCoordinator(), signInAsCoordinatorLead()]);
    const event = await submitEvent(organiser);
    await assignCoordinator(lead, event.id, coordinator.id);
    await requestClarification(coordinator, event.id, "How many of the 50 are external guests?");

    await expectRefused(approveRequest(coordinator, event.id), 409);
    expect((await getEvent(organiser, event.id)).status).toBe("Clarification Requested");
  });

  test("cancelling and safety rejection both need a reason", async () => {
    test.setTimeout(60_000);
    const { event, organiser } = await climbToConfirmed("rules-reasons");
    await expectRefused(cancelEvent(organiser, event.id, "   "), 400);
    expect((await getEvent(organiser, event.id)).status).toBe("Confirmed");

    const safetyOfficer = await signInAsSafetyOfficer();
    // Confirmed isn't in Safety Review, so there's nothing to reject either way.
    await expectRefused(rejectSafetyReview(safetyOfficer, event.id, "Too late."), 409);
  });
});

test.describe("clarification returns to the status it came from", () => {
  test("asked during Requested: the organiser's answer puts it back to Requested", async () => {
    const organiser = await registerOrganiser("rules-clarify-requested");
    const [coordinator, lead] = await Promise.all([signInAsCoordinator(), signInAsCoordinatorLead()]);
    const event = await submitEvent(organiser);
    await assignCoordinator(lead, event.id, coordinator.id);

    const asked = await requestClarification(coordinator, event.id, "Is the date flexible?");
    expect(asked.status).toBe("Clarification Requested");

    const answered = await editEvent(organiser, event.id, {
      ...event.submitted_details,
      purpose: "Date is fixed.",
    });
    expect(answered.status).toBe("Requested");
  });

  test("asked during Planning: the answer puts it back to Planning, not Requested", async () => {
    const organiser = await registerOrganiser("rules-clarify-planning");
    const [coordinator, lead] = await Promise.all([signInAsCoordinator(), signInAsCoordinatorLead()]);
    const event = await submitEvent(organiser);
    await assignCoordinator(lead, event.id, coordinator.id);
    await approveRequest(coordinator, event.id);

    await requestClarification(coordinator, event.id, "Do you need the room the evening before?");
    const answered = await editEvent(organiser, event.id, {
      ...event.submitted_details,
      description: "No setup needed the evening before.",
    });
    expect(answered.status).toBe("Planning");
  });
});

test.describe("who may edit an event's details, and when", () => {
  test("the organiser can edit while Unassigned, and the edit is stored", async () => {
    const organiser = await registerOrganiser("rules-edit-unassigned");
    const event = await submitEvent(organiser);

    const edited = await editEvent(organiser, event.id, {
      ...event.submitted_details,
      expectedAttendance: 75,
    });
    expect(edited.status).toBe("Unassigned");
    expect((await getEvent(organiser, event.id)).submitted_details).toMatchObject({ expectedAttendance: 75 });
  });

  test("an invalid edit is refused and changes nothing", async () => {
    const organiser = await registerOrganiser("rules-edit-invalid");
    const event = await submitEvent(organiser);

    await expectRefused(editEvent(organiser, event.id, eventDetails({ endTime: "09:00" })), 400);
    expect((await getEvent(organiser, event.id)).submitted_details).toMatchObject({ endTime: "12:00" });
  });

  test("the coordinator can't edit before Planning", async () => {
    const organiser = await registerOrganiser("rules-edit-coord-early");
    const [coordinator, lead] = await Promise.all([signInAsCoordinator(), signInAsCoordinatorLead()]);
    const event = await submitEvent(organiser);
    await assignCoordinator(lead, event.id, coordinator.id);

    await expectRefused(
      editEvent(coordinator, event.id, {
        ...event.submitted_details,
        purpose: "Coordinator edit",
      }),
      409,
    );
  });

  test("nobody can edit a Confirmed event directly", async () => {
    test.setTimeout(60_000);
    const { event, organiser, coordinator } = await climbToConfirmed("rules-edit-confirmed");
    const details = {
      ...event.submitted_details,
      purpose: "Too late to change this way",
    };

    await expectRefused(editEvent(organiser, event.id, details), 409);
    await expectRefused(editEvent(coordinator, event.id, details), 409);
    expect((await getEvent(organiser, event.id)).submitted_details).not.toMatchObject({ purpose: details.purpose });
  });
});

test.describe("the Lead reassigning a coordinator (E2-12)", () => {
  test("moves the event to the new coordinator without changing its status, and records who it was", async () => {
    const organiser = await registerOrganiser("rules-reassign");
    const [first, lead] = await Promise.all([signInAsCoordinator(), signInAsCoordinatorLead()]);
    const second = await signInAsSeeded(SEEDED_ACCOUNTS.coordinatorTwo);
    const event = await submitEvent(organiser);
    await assignCoordinator(lead, event.id, first.id);

    // Reassigning to whoever already has it isn't a reassignment.
    await expectRefused(reassignCoordinator(lead, event.id, first.id), 400);

    const moved = await reassignCoordinator(lead, event.id, second.id);
    expect(moved.status).toBe("Requested");
    expect(moved.coordinator_id).toBe(second.id);

    const history = await fetchEventHistory(lead, event.id);
    expect(history).toContainEqual(
      expect.objectContaining({ field: "Coordinator", old_value: first.name, new_value: second.name }),
    );

    // The previous coordinator has lost it; the new one can act.
    await expectRefused(approveRequest(first, event.id), 403);
    expect((await approveRequest(second, event.id)).status).toBe("Planning");

    // The previous coordinator is told it was taken off them.
    await expect
      .poll(
        async () =>
          (await fetchMyNotifications(first, 50)).some(
            (n) => n.eventId === event.id && n.type === "coordinator.reassigned",
          ),
        {
          message: "waiting for the previous coordinator's reassignment notification",
          timeout: 10_000,
        },
      )
      .toBe(true);
  });

  test("closed events can't be reassigned", async () => {
    const organiser = await registerOrganiser("rules-reassign-closed");
    const [first, lead] = await Promise.all([signInAsCoordinator(), signInAsCoordinatorLead()]);
    const second = await signInAsSeeded(SEEDED_ACCOUNTS.coordinatorTwo);
    const event = await submitEvent(organiser);
    await assignCoordinator(lead, event.id, first.id);
    await rejectRequest(first, event.id, "Not this term.");

    await expectRefused(reassignCoordinator(lead, event.id, second.id), 409);
  });
});
