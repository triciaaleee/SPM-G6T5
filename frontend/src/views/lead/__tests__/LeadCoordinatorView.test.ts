import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import LeadCoordinatorView from "../LeadCoordinatorView.vue";
import * as eventsApi from "../../lib/eventsApi";
import * as usersApi from "../../lib/usersApi";

vi.mock("../../lib/eventsApi", () => ({ fetchMyEvents: vi.fn() }));
vi.mock("../../lib/usersApi", () => ({ fetchCoordinators: vi.fn() }));

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/lead", name: "lead-dashboard", component: { template: "<div/>" } },
    { path: "/lead/coordinators/:id", name: "lead-coordinator", component: { template: "<div/>" } },
    { path: "/events/:id", name: "event-detail", component: { template: "<div/>" } },
  ],
});

type EventSummary = eventsApi.EventSummary;

function makeEvent(id: number, overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id,
    status: "Planning",
    submitted_details: { name: `Event ${id}`, proposedDate: `2099-11-${String(id).padStart(2, "0")}` },
    coordinator_id: "COORD-0001",
    coordinator: { name: "Priya Nair" },
    organiser: { name: "Organiser Two" },
    review_outcome: null,
    decided_at: null,
    decided_by: null,
    created_at: "2026-10-08T00:00:00Z",
    ...overrides,
  };
}

async function mountView(coordinatorId: string, events: EventSummary[]) {
  vi.mocked(usersApi.fetchCoordinators).mockResolvedValue([{ id: "COORD-0001", name: "Priya Nair" }]);
  vi.mocked(eventsApi.fetchMyEvents).mockResolvedValue(events);
  await router.push(`/lead/coordinators/${coordinatorId}`);
  await router.isReady();
  const wrapper = mount(LeadCoordinatorView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LeadCoordinatorView", () => {
  it("lists every active event of the coordinator, soonest first", async () => {
    const wrapper = await mountView("COORD-0001", [
      makeEvent(5),
      makeEvent(1),
      makeEvent(3),
      makeEvent(2),
      makeEvent(4, { status: "Completed" }),
      makeEvent(6, { coordinator_id: "COORD-0002", coordinator: { name: "Someone Else" } }),
    ]);

    expect(wrapper.find("h1").text()).toBe("Priya Nair");
    expect(wrapper.find(".subheading").text()).toContain("4 active events");
    expect(wrapper.findAll(".cell-event__name").map((n) => n.text())).toEqual(["Event 1", "Event 2", "Event 3", "Event 5"]);
    expect(wrapper.findAll(".cell-header").map((h) => h.text())).toEqual([
      "Event", "Date", "Time", "Venue", "Organiser", "Status",
    ]);
    expect(wrapper.find(".back-link").attributes("href")).toBe("/lead");
  });

  it("says so for an unknown coordinator", async () => {
    const wrapper = await mountView("COORD-9999", []);

    expect(wrapper.find("[role='alert']").text()).toBe("Coordinator not found.");
  });
});
