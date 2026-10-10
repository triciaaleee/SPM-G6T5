import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import LeadDashboardView from "../LeadDashboardView.vue";
import * as eventsApi from "../../lib/eventsApi";

vi.mock("../../lib/eventsApi", () => ({
  fetchUnassignedQueue: vi.fn(),
  fetchMyEvents: vi.fn(),
}));

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<div/>" } },
    { path: "/events/:id", name: "event-detail", component: { template: "<div/>" } },
  ],
});

type EventSummary = eventsApi.EventSummary;

function makeEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: 1,
    status: "Unassigned",
    submitted_details: { name: "Robotics Demo Day", proposedDate: "2099-09-28" },
    coordinator_id: null,
    coordinator: null,
    organiser: { name: "Organiser Two" },
    review_outcome: null,
    decided_at: null,
    decided_by: null,
    created_at: "2026-10-08T00:00:00Z",
    ...overrides,
  };
}

async function mountView(queue: EventSummary[], all: EventSummary[] = []) {
  vi.mocked(eventsApi.fetchUnassignedQueue).mockResolvedValue(queue);
  vi.mocked(eventsApi.fetchMyEvents).mockResolvedValue(all);
  const wrapper = mount(LeadDashboardView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LeadDashboardView — unassigned queue (E1-8)", () => {
  it("shows each request's event name, event date and submission date (AC1)", async () => {
    const wrapper = await mountView([makeEvent()]);

    const card = wrapper.find(".event-card");
    expect(card.text()).toContain("Robotics Demo Day");
    expect(card.text()).toContain("Event date");
    expect(card.text()).toContain("September 28, 2099");
    expect(card.text()).toContain("Submitted");
    expect(card.text()).toContain("October 8, 2026");
  });

  it("links each request to its read-only detail page (AC2)", async () => {
    const wrapper = await mountView([makeEvent({ id: 6 })]);

    expect(wrapper.find(".event-card").attributes("href")).toBe("/events/6");
  });

  it("keeps the backend's oldest-first order", async () => {
    const wrapper = await mountView([
      makeEvent({ id: 1, submitted_details: { name: "First in" } }),
      makeEvent({ id: 2, submitted_details: { name: "Second in" } }),
    ]);

    const cards = wrapper.findAll(".event-card");
    expect(cards[0].text()).toContain("First in");
    expect(cards[1].text()).toContain("Second in");
  });

  it("says so when nothing is waiting", async () => {
    const wrapper = await mountView([]);

    expect(wrapper.text()).toContain("No requests are waiting for a coordinator.");
  });

  it("shows an error when loading fails", async () => {
    vi.mocked(eventsApi.fetchUnassignedQueue).mockRejectedValue(new Error("boom"));
    vi.mocked(eventsApi.fetchMyEvents).mockResolvedValue([]);
    const wrapper = mount(LeadDashboardView, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("We couldn't load the events.");
  });
});

describe("LeadDashboardView — active events (Week 7 change 5)", () => {
  it("groups active events by coordinator and leaves out closed and unassigned ones", async () => {
    const all = [
      makeEvent({ id: 1, status: "Planning", coordinator_id: "COORD-0002", coordinator: { name: "Coordinator Two" } }),
      makeEvent({ id: 2, status: "Requested", coordinator_id: "COORD-0001", coordinator: { name: "Coordinator One" } }),
      makeEvent({ id: 3, status: "Completed", coordinator_id: "COORD-0001", coordinator: { name: "Coordinator One" } }),
      makeEvent({ id: 4, status: "Unassigned" }),
    ];
    const wrapper = await mountView([], all);

    await wrapper.findAll(".toggle-btn")[1].trigger("click");

    const groups = wrapper.findAll(".coordinator-group");
    expect(groups).toHaveLength(2);
    expect(groups[0].find(".group-label").text()).toBe("Coordinator One");
    expect(groups[0].findAll(".event-card")).toHaveLength(1);
    expect(groups[1].find(".group-label").text()).toBe("Coordinator Two");
  });
});
