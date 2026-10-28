import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import LeadUnassignedQueueView from "../LeadUnassignedQueueView.vue";
import * as eventsApi from "../../lib/eventsApi";

vi.mock("../../lib/eventsApi", () => ({ fetchUnassignedQueue: vi.fn() }));

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<div/>" } },
    { path: "/lead", name: "lead-dashboard", component: { template: "<div/>" } },
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

async function mountView(queue: EventSummary[]) {
  vi.mocked(eventsApi.fetchUnassignedQueue).mockResolvedValue(queue);
  const wrapper = mount(LeadUnassignedQueueView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LeadUnassignedQueueView (E1-8)", () => {
  it("shows each request's event name, event date and submission date (AC1)", async () => {
    const wrapper = await mountView([makeEvent()]);

    const card = wrapper.find(".event-card");
    expect(card.text()).toContain("Robotics Demo Day");
    expect(card.text()).toContain("Event date");
    expect(card.text()).toContain("September 28, 2099");
    expect(card.text()).toContain("Submitted");
    expect(card.text()).toContain("October 8, 2026");
  });

  it("links each request to its detail page (AC2)", async () => {
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

  it("links back to the overview", async () => {
    const wrapper = await mountView([]);

    expect(wrapper.find(".back-link").attributes("href")).toBe("/lead");
  });

  it("shows an error when loading fails", async () => {
    vi.mocked(eventsApi.fetchUnassignedQueue).mockRejectedValue(new Error("boom"));
    const wrapper = mount(LeadUnassignedQueueView, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain("We couldn't load the events.");
  });
});
