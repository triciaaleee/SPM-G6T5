import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import EventDetailView from "../EventDetailView.vue";
import {
  cancelEvent,
  completeEvent,
  fetchChangeRequests,
  fetchEventById,
  fetchEventHistory,
  getCurrentUser,
  ReviewActionError,
  submitChangeRequest,
  type ChangeRequestEntry,
  type EventSummary,
} from "../../lib/eventsApi";
import { fetchEventVenueBookings } from "../../lib/venuesApi";

vi.mock("../../lib/eventsApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/eventsApi")>("../../lib/eventsApi");
  return {
    ...actual,
    fetchEventById: vi.fn(),
    getCurrentUser: vi.fn(),
    fetchEventHistory: vi.fn(),
    completeEvent: vi.fn(),
    cancelEvent: vi.fn(),
    fetchChangeRequests: vi.fn(),
    submitChangeRequest: vi.fn(),
  };
});

vi.mock("../../lib/venuesApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/venuesApi")>("../../lib/venuesApi");
  return { ...actual, fetchEventVenueBookings: vi.fn() };
});

vi.mock("../../lib/equipmentApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/equipmentApi")>("../../lib/equipmentApi");
  return { ...actual, fetchEquipmentRequestsForEvent: vi.fn().mockResolvedValue([]) };
});

const mockedFetchEvent = vi.mocked(fetchEventById);
const mockedUser = vi.mocked(getCurrentUser);
const mockedHistory = vi.mocked(fetchEventHistory);
const mockedComplete = vi.mocked(completeEvent);
const mockedCancel = vi.mocked(cancelEvent);
const mockedBookings = vi.mocked(fetchEventVenueBookings);
const mockedChangeRequests = vi.mocked(fetchChangeRequests);
const mockedSubmitChangeRequest = vi.mocked(submitChangeRequest);

const coordinator = { id: "COORD-0001", role: "coordinator" };

// Ends 18:00 Singapore time on 10 Nov 2026 = 10:00 UTC.
const AFTER_END = new Date("2026-11-10T10:30:00.000Z");
const BEFORE_END = new Date("2026-11-10T09:30:00.000Z");

function makeEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: 7,
    status: "Confirmed",
    submitted_details: {
      name: "Spring Gala",
      proposedDate: "2026-11-10",
      startTime: "10:00",
      endTime: "18:00",
      expectedAttendance: 200,
    },
    coordinator_id: coordinator.id,
    coordinator: { name: "Casey Coordinator" },
    organiser: { name: "Olive Organiser" },
    review_outcome: null,
    decided_at: "2026-10-01T00:00:00.000Z",
    decided_by: coordinator.id,
    created_at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  } as EventSummary;
}

async function mountPage(event: EventSummary, user: { id: string; role: string } = coordinator) {
  mockedFetchEvent.mockResolvedValue(event);
  mockedUser.mockResolvedValue(user);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/events/:id", name: "event-detail", component: EventDetailView },
      { path: "/venues/search", name: "venue-search", component: { render: () => h("div") } },
      { path: "/:pathMatch(.*)*", component: { render: () => h("div") } },
    ],
  });
  await router.push("/events/7");
  await router.isReady();
  const wrapper = mount(EventDetailView, {
    global: {
      plugins: [router],
      stubs: {
        VenueRecommendations: true,
        EquipmentRequestPanel: true,
        ClarificationPanel: true,
        SafetyReviewPanel: true,
        RegistrationsPanel: true,
      },
    },
  });
  await flushPromises();
  return wrapper;
}

function button(wrapper: Awaited<ReturnType<typeof mountPage>>, text: string) {
  return wrapper.findAll("button").find((b) => b.text() === text);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(AFTER_END);
  mockedHistory.mockResolvedValue([]);
  mockedBookings.mockResolvedValue([]);
  mockedChangeRequests.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EventDetailView — Mark as completed (E3-5)", () => {
  it("AC1: the assigned coordinator completes a Confirmed event that has ended, after confirming", async () => {
    mockedComplete.mockResolvedValue(makeEvent({ status: "Completed" }));
    const wrapper = await mountPage(makeEvent());

    await button(wrapper, "Mark as completed")!.trigger("click");
    expect(mockedComplete).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("This can't be undone");

    await button(wrapper, "Confirm")!.trigger("click");
    await flushPromises();

    expect(mockedComplete).toHaveBeenCalledWith(7);
    expect(wrapper.text()).toContain("This event has been completed.");
    expect(button(wrapper, "Mark as completed")).toBeUndefined();
    // The history reloads so the completion row shows straight away.
    expect(mockedHistory).toHaveBeenCalledTimes(2);
  });

  it("AC2: blocks the action before the event has ended and says when it can be done", async () => {
    vi.setSystemTime(BEFORE_END);
    const wrapper = await mountPage(makeEvent());

    expect(button(wrapper, "Mark as completed")!.attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="complete-blocked"]').text()).toContain("at 18:00");
  });

  it("Cancel backs out without completing", async () => {
    const wrapper = await mountPage(makeEvent());

    await button(wrapper, "Mark as completed")!.trigger("click");
    await button(wrapper, "Cancel")!.trigger("click");

    expect(mockedComplete).not.toHaveBeenCalled();
    expect(button(wrapper, "Mark as completed")).toBeDefined();
  });

  it("shows the server's message when completing is refused", async () => {
    mockedComplete.mockRejectedValue(new ReviewActionError("This event is no longer Confirmed or no longer assigned to you"));
    const wrapper = await mountPage(makeEvent());

    await button(wrapper, "Mark as completed")!.trigger("click");
    await button(wrapper, "Confirm")!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("This event is no longer Confirmed or no longer assigned to you");
  });

  it("isn't offered to a coordinator the event isn't assigned to", async () => {
    const wrapper = await mountPage(makeEvent({ coordinator_id: "COORD-0002" }));
    expect(button(wrapper, "Mark as completed")).toBeUndefined();
  });

  it("isn't offered before the event is Confirmed", async () => {
    const wrapper = await mountPage(makeEvent({ status: "Safety Review" }));
    expect(button(wrapper, "Mark as completed")).toBeUndefined();
  });

  it("isn't offered to the organiser", async () => {
    const wrapper = await mountPage(makeEvent(), { id: "ORG-0001", role: "organiser" });
    expect(button(wrapper, "Mark as completed")).toBeUndefined();
  });
});

describe("EventDetailView — Cancel event (E3-6)", () => {
  const organiser = { id: "ORG-0001", role: "organiser" };

  it("AC1: the owning organiser cancels an active event with a reason", async () => {
    mockedCancel.mockResolvedValue(makeEvent({ status: "Cancelled", review_outcome: "Venue flooded" }));
    const wrapper = await mountPage(makeEvent({ status: "Planning" }), organiser);

    await button(wrapper, "Cancel event")!.trigger("click");
    expect(mockedCancel).not.toHaveBeenCalled();

    await wrapper.get("#cancel-reason").setValue("Venue flooded");
    await button(wrapper, "Confirm cancellation")!.trigger("click");
    await flushPromises();

    expect(mockedCancel).toHaveBeenCalledWith(7, "Venue flooded");
    expect(wrapper.text()).toContain('This event was cancelled: "Venue flooded"');
    expect(button(wrapper, "Cancel event")).toBeUndefined();
  });

  it("AC2: keeps the confirm button disabled until a reason is entered", async () => {
    const wrapper = await mountPage(makeEvent({ status: "Planning" }), organiser);

    await button(wrapper, "Cancel event")!.trigger("click");
    expect(button(wrapper, "Confirm cancellation")!.attributes("disabled")).toBeDefined();

    await button(wrapper, "Confirm cancellation")!.trigger("click");
    expect(mockedCancel).not.toHaveBeenCalled();

    await wrapper.get("#cancel-reason").setValue("Venue flooded");
    expect(button(wrapper, "Confirm cancellation")!.attributes("disabled")).toBeUndefined();
  });

  it("Keep event closes the form without cancelling", async () => {
    const wrapper = await mountPage(makeEvent({ status: "Planning" }), organiser);

    await button(wrapper, "Cancel event")!.trigger("click");
    await button(wrapper, "Keep event")!.trigger("click");

    expect(mockedCancel).not.toHaveBeenCalled();
    expect(button(wrapper, "Cancel event")).toBeDefined();
  });

  it("shows the server's message when cancellation is refused", async () => {
    mockedCancel.mockRejectedValue(new ReviewActionError("This event is Completed and can no longer be cancelled."));
    const wrapper = await mountPage(makeEvent({ status: "Planning" }), organiser);

    await button(wrapper, "Cancel event")!.trigger("click");
    await wrapper.get("#cancel-reason").setValue("Venue flooded");
    await button(wrapper, "Confirm cancellation")!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("This event is Completed and can no longer be cancelled.");
  });

  it("isn't offered to a coordinator", async () => {
    const wrapper = await mountPage(makeEvent({ status: "Planning" }));
    expect(button(wrapper, "Cancel event")).toBeUndefined();
  });

  it("isn't offered for a Draft event", async () => {
    const wrapper = await mountPage(makeEvent({ status: "Draft" }), organiser);
    expect(button(wrapper, "Cancel event")).toBeUndefined();
  });

  it("isn't offered once the event is already closed", async () => {
    const wrapper = await mountPage(makeEvent({ status: "Completed" }), organiser);
    expect(button(wrapper, "Cancel event")).toBeUndefined();
    expect(wrapper.text()).not.toContain("This event was cancelled");
  });
});

describe("EventDetailView — a Completed event's record (E3-5 AC3)", () => {
  it("still loads and lists the venue bookings for the coordinator", async () => {
    mockedBookings.mockResolvedValue([
      {
        id: 900,
        status: "Approved",
        holdExpiresAt: null,
        decisionReason: null,
        createdAt: "2026-10-07T02:00:00.000Z",
        venue: { id: 1, name: "Grand Ballroom", location: "Central Campus" },
      },
    ]);
    const wrapper = await mountPage(makeEvent({ status: "Completed" }));

    expect(mockedBookings).toHaveBeenCalledWith(7);
    expect(wrapper.text()).toContain("Grand Ballroom");
    expect(wrapper.text()).not.toContain("Loading venue requests");
  });

  it("still shows the event history", async () => {
    mockedHistory.mockResolvedValue([
      {
        id: 1,
        field: "Status",
        old_value: "Confirmed",
        new_value: "Completed",
        changed_by: coordinator.id,
        changed_by_user: { name: "Casey Coordinator", role: "coordinator" },
        changed_at: "2026-11-10T11:00:00.000Z",
      },
    ] as Awaited<ReturnType<typeof fetchEventHistory>>);
    const wrapper = await mountPage(makeEvent({ status: "Completed" }));
    await button(wrapper, "History")!.trigger("click");

    expect(wrapper.text()).toContain("Status changed from");
    expect(wrapper.text()).toContain("'Completed'");
  });
});

describe("EventDetailView — registrations (E3-5 AC3)", () => {
  function withRegistration(status: string) {
    const event = makeEvent({ status });
    return makeEvent({
      status,
      submitted_details: { ...(event.submitted_details as Record<string, unknown>), registrationNeeded: true },
    });
  }

  function hasRegistrations(wrapper: Awaited<ReturnType<typeof mountPage>>) {
    return wrapper.findComponent({ name: "RegistrationsPanel" }).exists();
  }

  it("shows a Completed event's registrations to the coordinator", async () => {
    expect(hasRegistrations(await mountPage(withRegistration("Completed")))).toBe(true);
  });

  it("shows them to the owning organiser", async () => {
    expect(hasRegistrations(await mountPage(withRegistration("Completed"), { id: "ORG-0001", role: "organiser" }))).toBe(true);
  });

  it("doesn't show them to the Lead, whom registration-service refuses", async () => {
    expect(hasRegistrations(await mountPage(withRegistration("Completed"), { id: "LEAD-0001", role: "coordinator_lead" }))).toBe(false);
  });

  it("doesn't show them for an event that didn't ask for registration", async () => {
    expect(hasRegistrations(await mountPage(makeEvent({ status: "Completed" })))).toBe(false);
  });
});

describe("EventDetailView — change requests (E3-9)", () => {
  const organiser = { id: "ORG-0001", role: "organiser" };

  function changeRequest(overrides: Partial<ChangeRequestEntry> = {}): ChangeRequestEntry {
    return {
      id: 55,
      status: "Pending",
      decidedAt: null,
      decisionReason: null,
      createdAt: "2026-10-16T00:00:00.000Z",
      fields: [{ field: "venue", oldValue: "Grand Ballroom", newValue: "Seminar Room 3-01", isCritical: true }],
      impact: null,
      ...overrides,
    };
  }

  it("shows nothing when the organiser has never raised one", async () => {
    mockedChangeRequests.mockResolvedValue([]);
    const wrapper = await mountPage(makeEvent(), organiser);
    expect(wrapper.text()).not.toContain("Change request");
  });

  it("shows the requested-changes grid with the current and requested value for a pending critical change", async () => {
    mockedChangeRequests.mockResolvedValue([changeRequest()]);
    const wrapper = await mountPage(makeEvent(), organiser);

    expect(wrapper.text()).toContain("Pending review");
    expect(wrapper.text()).toContain("Requested changes");
    expect(wrapper.text()).toContain("Seminar Room 3-01");
    expect(wrapper.text()).toContain("(was Grand Ballroom)");
    expect(wrapper.text()).toContain("awaiting review");
  });

  it("doesn't repeat a held field in the already-applied details, and uses singular 'is' for one item", async () => {
    mockedChangeRequests.mockResolvedValue([changeRequest()]); // venue held
    const wrapper = await mountPage(makeEvent(), organiser);

    expect(wrapper.text()).toContain("Your requested venue is awaiting review");
    expect(wrapper.text()).toContain("Event details");
    expect(wrapper.text()).toContain("Already applied");
    // "Venue Requirements" appears once in the requested-changes grid
    // (held) — not repeated in the already-applied section below it.
    const cardText = wrapper.find(".change-request-card").text();
    expect(cardText.match(/Venue Requirements/g)?.length).toBe(1);
  });

  it("folds startTime and endTime into one 'times' word in the summary sentence", async () => {
    mockedChangeRequests.mockResolvedValue([
      changeRequest({
        fields: [
          { field: "startTime", oldValue: "10:00", newValue: "11:00", isCritical: true },
          { field: "endTime", oldValue: "12:00", newValue: "13:00", isCritical: true },
        ],
      }),
    ]);
    const wrapper = await mountPage(makeEvent(), organiser);

    expect(wrapper.text()).toContain("Your requested times are awaiting review");
  });

  it("shows a rejected request with its reason, and no requested-changes section", async () => {
    mockedChangeRequests.mockResolvedValue([
      changeRequest({
        status: "Rejected",
        decisionReason: "Venue too small for the new headcount",
        fields: [], // E3-11 (not built) would decide what happens to held fields on reject; nothing held today.
      }),
    ]);
    const wrapper = await mountPage(makeEvent(), organiser);

    expect(wrapper.text()).toContain("Rejected");
    expect(wrapper.text()).toContain("Venue too small for the new headcount");
    expect(wrapper.text()).not.toContain("Requested changes");
  });

  it("shows a Withdrawn badge, not Approved, for an auto-resolved request", async () => {
    mockedChangeRequests.mockResolvedValue([
      changeRequest({
        status: "Auto-Withdrawn",
        decisionReason: "The requested change to venue was reverted before it was reviewed.",
        fields: [], // the backend deletes reverted critical fields, so none are held once withdrawn.
      }),
    ]);
    const wrapper = await mountPage(makeEvent(), organiser);

    expect(wrapper.text()).toContain("Withdrawn");
    expect(wrapper.text()).not.toContain("Approved");
    expect(wrapper.text()).toContain("there's nothing pending anymore");
  });

  it("doesn't call out a plain Approved request (purely non-critical) as withdrawn", async () => {
    mockedChangeRequests.mockResolvedValue([changeRequest({ status: "Approved", decisionReason: null })]);
    const wrapper = await mountPage(makeEvent(), organiser);

    expect(wrapper.text()).toContain("Approved");
    expect(wrapper.text()).not.toContain("Withdrawn");
  });

  it("explains an auto-applied request as automatic, not a coordinator decision", async () => {
    mockedChangeRequests.mockResolvedValue([
      changeRequest({
        status: "Approved",
        decisionReason: "Applied automatically — description",
        fields: [{ field: "description", oldValue: "old", newValue: "new", isCritical: false }],
      }),
    ]);
    const wrapper = await mountPage(makeEvent(), organiser);

    expect(wrapper.text()).toContain("Applied");
    expect(wrapper.text()).not.toContain("Withdrawn");
    expect(wrapper.text()).toContain("Applied automatically");
    expect(wrapper.text()).toContain("none of the changed fields needed your coordinator's review");
  });
});

describe("EventDetailView — submitting a change request (E3-9 merge)", () => {
  const organiser = { id: "ORG-0001", role: "organiser" };

  function changeRequest(overrides: Partial<ChangeRequestEntry> = {}): ChangeRequestEntry {
    return {
      id: 55,
      status: "Pending",
      decidedAt: null,
      decisionReason: null,
      createdAt: "2026-10-16T00:00:00.000Z",
      fields: [{ field: "venue", oldValue: "Grand Ballroom", newValue: "Seminar Room 3-01", isCritical: true }],
      impact: null,
      ...overrides,
    };
  }

  function eventWithVenue(venue: string) {
    return makeEvent({
      submitted_details: {
        name: "Spring Gala",
        purpose: "Celebration",
        description: "A gala",
        proposedDate: "2026-11-10",
        startTime: "10:00",
        endTime: "18:00",
        expectedAttendance: 200,
        venue,
        accessibility: "Step-free access",
        equipment: "Stage",
        technicalSupport: "AV crew",
        registrationNeeded: false,
      },
    });
  }

  it("pre-fills a held field with its requested value, not the committed one", async () => {
    mockedChangeRequests.mockResolvedValue([changeRequest()]);
    const wrapper = await mountPage(eventWithVenue("Grand Ballroom"), organiser);

    await wrapper.find('[title="Request a change"]').trigger("click");

    const venueInput = wrapper.get("#edit-venue");
    expect((venueInput.element as HTMLTextAreaElement).value).toBe("Seminar Room 3-01");
  });

  it("shows reverted fields and the auto-resolved note after a response says so", async () => {
    mockedChangeRequests.mockResolvedValue([changeRequest()]);
    mockedSubmitChangeRequest.mockResolvedValue({
      changeRequestId: 55,
      applied: [],
      held: [],
      reverted: ["venue"],
      autoResolved: true,
      notificationsFailed: false,
    });
    const wrapper = await mountPage(eventWithVenue("Grand Ballroom"), organiser);

    await wrapper.find('[title="Request a change"]').trigger("click");
    await wrapper.get("#edit-venue").setValue("Grand Ballroom");
    await button(wrapper, "Submit change request")!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("No longer pending (back to how it was)");
    expect(wrapper.text()).toContain("venue");
    expect(wrapper.text()).toContain("Nothing is pending on this event anymore.");
  });
});

describe("EventDetailView — change request impact for the coordinator (E3-8 AC2/AC4)", () => {
  function impact(overrides: Partial<NonNullable<ChangeRequestEntry["impact"]>> = {}) {
    return {
      bookings: [{ id: 900, status: "Approved", venue: { id: 1, name: "Grand Ballroom" } }],
      equipmentReservations: [{ id: 50, status: "Arranged", items: [] }],
      registrations: { registeredCount: 3, total: 5, registrations: [] },
      capacityConflict: null,
      availabilityConflict: null,
      ...overrides,
    };
  }

  function pendingRequest(overrides: Partial<ChangeRequestEntry> = {}): ChangeRequestEntry {
    return {
      id: 55,
      status: "Pending",
      decidedAt: null,
      decisionReason: null,
      createdAt: "2026-10-16T00:00:00.000Z",
      fields: [{ field: "expectedAttendance", oldValue: "200", newValue: "350", isCritical: true }],
      impact: impact(),
      ...overrides,
    };
  }

  it("shows the pending request with its held field and impact to the assigned coordinator", async () => {
    mockedChangeRequests.mockResolvedValue([pendingRequest()]);
    const wrapper = await mountPage(makeEvent(), coordinator);

    expect(wrapper.text()).toContain("Change request pending your review");
    expect(wrapper.text()).toContain("200");
    expect(wrapper.text()).toContain("350");
    expect(wrapper.text()).toContain("Grand Ballroom");
    expect(wrapper.text()).toContain("3 registered of");
  });

  it("shows an explicit capacity conflict banner", async () => {
    mockedChangeRequests.mockResolvedValue([
      pendingRequest({
        impact: impact({
          capacityConflict: { bookingId: 900, venueName: "Grand Ballroom", capacity: 300, requestedAttendance: 350 },
        }),
      }),
    ]);
    const wrapper = await mountPage(makeEvent(), coordinator);

    expect(wrapper.text()).toContain("Capacity conflict");
    expect(wrapper.text()).toContain("Grand Ballroom holds");
  });

  it("shows an explicit unavailability-period conflict banner", async () => {
    mockedChangeRequests.mockResolvedValue([
      pendingRequest({
        impact: impact({
          availabilityConflict: {
            bookingId: 900,
            unavailabilityConflict: { reason: "maintenance", description: "on 2026-11-10 (all day)" },
            bookingConflict: null,
          },
        }),
      }),
    ]);
    const wrapper = await mountPage(makeEvent(), coordinator);

    expect(wrapper.text()).toContain("Availability conflict");
    expect(wrapper.text()).toContain("maintenance");
  });

  it("shows an explicit rival-booking conflict banner", async () => {
    mockedChangeRequests.mockResolvedValue([
      pendingRequest({
        impact: impact({
          availabilityConflict: {
            bookingId: 900,
            unavailabilityConflict: null,
            bookingConflict: { bookingId: 901, status: "Approved", window: "2026-11-10 09:30–12:45" },
          },
        }),
      }),
    ]);
    const wrapper = await mountPage(makeEvent(), coordinator);

    expect(wrapper.text()).toContain("Availability conflict");
    expect(wrapper.text()).toContain("Clashes with another booking");
  });

  it("shows the registration count against the proposed capacity", async () => {
    mockedChangeRequests.mockResolvedValue([
      pendingRequest({
        impact: impact({
          registrations: {
            registeredCount: 1,
            total: 2,
            registrations: [
              { registrationId: 1, userId: "ATT-1", name: "Ash", status: "Registered" },
              { registrationId: 2, userId: "ATT-2", name: "Bo", status: "Withdrawn" },
            ],
          },
        }),
      }),
    ]);
    const wrapper = await mountPage(makeEvent(), coordinator);

    expect(wrapper.text()).toContain("1 registered of");
    expect(wrapper.text()).toContain("2 total");
  });

  it("doesn't crash when the registration list is missing from the response", async () => {
    mockedChangeRequests.mockResolvedValue([
      pendingRequest({
        impact: impact({ registrations: { registeredCount: 0, total: 0 } as any }),
      }),
    ]);
    const wrapper = await mountPage(makeEvent(), coordinator);

    expect(wrapper.text()).toContain("Change request pending your review");
  });

  it("never offers an approve/reject action (E3-11 is not built)", async () => {
    mockedChangeRequests.mockResolvedValue([pendingRequest()]);
    const wrapper = await mountPage(makeEvent(), coordinator);

    expect(button(wrapper, "Approve")).toBeUndefined();
    expect(button(wrapper, "Reject")).toBeUndefined();
  });

  it("doesn't show it to a coordinator who isn't assigned to this event", async () => {
    mockedChangeRequests.mockResolvedValue([pendingRequest()]);
    const wrapper = await mountPage(makeEvent(), { id: "COORD-0002", role: "coordinator" });

    expect(wrapper.text()).not.toContain("Change request pending your review");
    expect(mockedChangeRequests).not.toHaveBeenCalled();
  });

  it("stays hidden when there's nothing pending", async () => {
    mockedChangeRequests.mockResolvedValue([]);
    const wrapper = await mountPage(makeEvent(), coordinator);
    expect(wrapper.text()).not.toContain("Change request pending your review");
  });

  it("shows the withdrawn reason instead of silently disappearing once the organiser reverts it", async () => {
    mockedChangeRequests.mockResolvedValue([
      pendingRequest({
        status: "Auto-Withdrawn",
        decisionReason: "The requested change to expectedAttendance was reverted before it was reviewed.",
        fields: [],
        impact: null,
      }),
    ]);
    const wrapper = await mountPage(makeEvent(), coordinator);

    expect(wrapper.text()).toContain("Withdrawn");
    expect(wrapper.text()).toContain("Nothing is pending on this event anymore.");
    expect(wrapper.text()).not.toContain("pending your review");
    expect(button(wrapper, "Approve")).toBeUndefined();
  });

  it("doesn't resurface an old withdrawal once something newer exists", async () => {
    mockedChangeRequests.mockResolvedValue([
      pendingRequest({ id: 56, status: "Approved", decisionReason: null, fields: [], impact: null }),
      pendingRequest({
        id: 55,
        status: "Auto-Withdrawn",
        decisionReason: "The requested change to expectedAttendance was reverted before it was reviewed.",
        fields: [],
        impact: null,
      }),
    ]);
    const wrapper = await mountPage(makeEvent(), coordinator);

    expect(wrapper.text()).not.toContain("Withdrawn");
  });

  it("tells the coordinator a purely non-critical submission applied automatically, not that it's pending their review", async () => {
    mockedChangeRequests.mockResolvedValue([
      pendingRequest({
        status: "Approved",
        decisionReason: "Applied automatically — description",
        fields: [{ field: "description", oldValue: "old", newValue: "new", isCritical: false }],
        impact: null,
      }),
    ]);
    const wrapper = await mountPage(makeEvent(), coordinator);

    expect(wrapper.text()).toContain("Applied automatically");
    expect(wrapper.text()).not.toContain("pending your review");
    expect(button(wrapper, "Approve")).toBeUndefined();
  });
});
