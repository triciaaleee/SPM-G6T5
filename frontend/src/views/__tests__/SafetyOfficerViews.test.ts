import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import SafetyQueueView from "../SafetyQueueView.vue";
import SafetyCheckView from "../SafetyCheckView.vue";
import * as eventsApi from "../../lib/eventsApi";
import * as venuesApi from "../../lib/venuesApi";
import * as equipmentApi from "../../lib/equipmentApi";

vi.mock("../../lib/eventsApi", () => {
  class AccessDeniedError extends Error {}
  class NotFoundError extends Error {}
  class NotAwaitingSafetyCheckError extends Error {}
  return {
    AccessDeniedError,
    NotFoundError,
    NotAwaitingSafetyCheckError,
    fetchSafetyQueue: vi.fn(),
    fetchSafetyCheck: vi.fn(),
  };
});
vi.mock("../../lib/venuesApi", () => ({ fetchEventVenueBookings: vi.fn() }));
vi.mock("../../lib/equipmentApi", () => ({ fetchEquipmentRequestsForEvent: vi.fn() }));

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/safety-reviews", name: "safety-queue", component: { template: "<div/>" } },
      { path: "/safety-reviews/:id", name: "safety-check", component: { template: "<div/>" } },
    ],
  });
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    status: "Safety Review",
    submitted_details: {
      name: "Robotics Showcase Night",
      proposedDate: "2026-11-14",
      startTime: "18:00",
      endTime: "21:00",
      expectedAttendance: 180,
      accessibility: "Step-free route to a reserved viewing area.",
    },
    coordinator_id: "COORD-0001",
    coordinator: { name: "Coordinator One" },
    organiser: { name: "Organiser One" },
    review_outcome: null,
    decided_at: null,
    decided_by: null,
    created_at: "2026-10-01T00:00:00Z",
    safety_submitted_at: "2026-10-08T00:00:00Z",
    ...overrides,
  } as unknown as eventsApi.SafetyQueueEvent;
}

const notes: eventsApi.SafetyNotes = {
  id: 3,
  equipmentPlacement: "Cables along the walls under covers.",
  crowdMovement: "Enter and exit by the foyer doors.",
  emergencyAccess: "Both east fire exits kept clear.",
  venueRestrictions: "No haze machines.",
  submittedAt: "2026-10-08T08:00:00Z",
  submittedBy: "Coordinator One",
};

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: "Approved",
    holdExpiresAt: null,
    decisionReason: null,
    createdAt: "2026-10-02T00:00:00Z",
    venue: { id: 9, name: "Black Box Studio", location: "South Campus", capacity: 200, layouts: ["Theatre", "Open floor"] },
    ...overrides,
  } as venuesApi.EventVenueBooking;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SafetyQueueView (E1-10 AC1)", () => {
  it("lists each event awaiting review and links to its safety check", async () => {
    vi.mocked(eventsApi.fetchSafetyQueue).mockResolvedValue([makeEvent()]);
    const wrapper = mount(SafetyQueueView, { global: { plugins: [makeRouter()] } });
    await flushPromises();

    const card = wrapper.find(".event-card");
    expect(card.text()).toContain("Robotics Showcase Night");
    expect(card.text()).toContain("November 14, 2026");
    expect(card.text()).toContain("18:00–21:00");
    expect(card.text()).toContain("180");
    expect(card.text()).toContain("Coordinator One");
    expect(card.attributes("href")).toBe("/safety-reviews/7");
  });

  it("says so when nothing is awaiting review", async () => {
    vi.mocked(eventsApi.fetchSafetyQueue).mockResolvedValue([]);
    const wrapper = mount(SafetyQueueView, { global: { plugins: [makeRouter()] } });
    await flushPromises();

    expect(wrapper.text()).toContain("No events are awaiting a safety check.");
  });
});

async function mountCheck() {
  const router = makeRouter();
  await router.push("/safety-reviews/7");
  const wrapper = mount(SafetyCheckView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

describe("SafetyCheckView (E1-10 AC2/AC4)", () => {
  beforeEach(() => {
    vi.mocked(eventsApi.fetchSafetyCheck).mockResolvedValue({ event: makeEvent(), safetyNotes: notes });
    vi.mocked(venuesApi.fetchEventVenueBookings).mockResolvedValue([booking()]);
    vi.mocked(equipmentApi.fetchEquipmentRequestsForEvent).mockResolvedValue([
      {
        id: 55,
        eventId: 7,
        status: "Arranged",
        fulfillmentNote: null,
        createdAt: "2026-10-03T00:00:00Z",
        items: [{ id: 1, equipmentType: "PA system", quantity: 2, quantityFulfilled: 2 }],
      },
    ]);
  });

  it("shows attendance, accessibility, each venue's capacity and layouts, the reserved equipment and the safety notes", async () => {
    const wrapper = await mountCheck();
    const text = wrapper.text();

    expect(text).toContain("180");
    expect(text).toContain("Step-free route to a reserved viewing area.");
    expect(text).toContain("Black Box Studio");
    expect(text).toContain("200");
    expect(text).toContain("Theatre");
    expect(text).toContain("Open floor");
    expect(text).toContain("PA system");
    expect(text).toContain(notes.equipmentPlacement);
    expect(text).toContain(notes.crowdMovement);
    expect(text).toContain(notes.emergencyAccess);
    expect(text).toContain(notes.venueRestrictions);
  });

  it("has no way to edit anything (AC4)", async () => {
    const wrapper = await mountCheck();

    expect(wrapper.findAll("input, textarea, select")).toHaveLength(0);
    expect(wrapper.findAll("button")).toHaveLength(0);
  });

  it("leaves out bookings that are no longer in play", async () => {
    vi.mocked(venuesApi.fetchEventVenueBookings).mockResolvedValue([
      booking(),
      booking({ id: 2, status: "Withdrawn", venue: { id: 3, name: "Lecture Theatre LT1", location: "Central Campus", capacity: 120, layouts: [] } }),
    ]);
    const wrapper = await mountCheck();

    expect(wrapper.text()).not.toContain("Lecture Theatre LT1");
  });

  it("flags attendance above a venue's capacity", async () => {
    vi.mocked(eventsApi.fetchSafetyCheck).mockResolvedValue({
      event: makeEvent({ submitted_details: { name: "Big", expectedAttendance: 250 } }),
      safetyNotes: notes,
    });
    const wrapper = await mountCheck();

    expect(wrapper.find(".capacity-warning").text()).toContain("250");
  });

  it("says when no equipment was requested", async () => {
    vi.mocked(equipmentApi.fetchEquipmentRequestsForEvent).mockResolvedValue([]);
    const wrapper = await mountCheck();

    expect(wrapper.text()).toContain("No equipment was requested for this event.");
  });

  it("shows access denied for anyone but the Safety Officer (AC5)", async () => {
    vi.mocked(eventsApi.fetchSafetyCheck).mockRejectedValue(new eventsApi.AccessDeniedError("no"));
    const wrapper = await mountCheck();

    expect(wrapper.text()).toContain("Access denied");
    expect(venuesApi.fetchEventVenueBookings).not.toHaveBeenCalled();
  });

  it("explains when the event is no longer in Safety Review", async () => {
    vi.mocked(eventsApi.fetchSafetyCheck).mockRejectedValue(new eventsApi.NotAwaitingSafetyCheckError("no"));
    const wrapper = await mountCheck();

    expect(wrapper.text()).toContain("no longer in Safety Review");
  });
});
