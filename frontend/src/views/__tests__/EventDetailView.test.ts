import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import EventDetailView from "../EventDetailView.vue";
import {
  cancelEvent,
  completeEvent,
  fetchEventById,
  fetchEventHistory,
  getCurrentUser,
  ReviewActionError,
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
