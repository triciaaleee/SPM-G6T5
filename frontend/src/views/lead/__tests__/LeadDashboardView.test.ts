import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import LeadDashboardView from "../LeadDashboardView.vue";
import * as eventsApi from "../../lib/eventsApi";
import * as usersApi from "../../lib/usersApi";

vi.mock("../../lib/eventsApi", () => ({
  fetchUnassignedQueue: vi.fn(),
  fetchMyEvents: vi.fn(),
}));
vi.mock("../../lib/usersApi", () => ({ fetchCoordinators: vi.fn() }));

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<div/>" } },
    { path: "/events/:id", name: "event-detail", component: { template: "<div/>" } },
    { path: "/lead/unassigned", name: "lead-unassigned", component: { template: "<div/>" } },
    { path: "/lead/coordinators/:id", name: "lead-coordinator", component: { template: "<div/>" } },
  ],
});

type EventSummary = eventsApi.EventSummary;

const PRIYA = { id: "COORD-0001", name: "Priya Nair" };
const AISHA = { id: "COORD-0002", name: "Aisha Rahman" };
const JOEL = { id: "COORD-0003", name: "Joel Chua" };

function makeEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: 1,
    status: "Planning",
    submitted_details: { name: "Robotics Demo Day", proposedDate: "2099-11-12", venue: "Main Hall" },
    coordinator_id: PRIYA.id,
    coordinator: { name: PRIYA.name },
    organiser: { name: "Organiser Two" },
    review_outcome: null,
    decided_at: null,
    decided_by: null,
    created_at: "2026-10-08T00:00:00Z",
    ...overrides,
  };
}

/** n events for one coordinator, dated 1..n Nov so their order is known. */
function eventsFor(coordinator: { id: string; name: string }, n: number, firstId: number): EventSummary[] {
  return Array.from({ length: n }, (_, i) =>
    makeEvent({
      id: firstId + i,
      coordinator_id: coordinator.id,
      coordinator: { name: coordinator.name },
      submitted_details: { name: `${coordinator.name} event ${i + 1}`, proposedDate: `2099-11-${String(i + 1).padStart(2, "0")}` },
    }),
  );
}

async function mountView({
  coordinators = [PRIYA, AISHA, JOEL],
  events = [] as EventSummary[],
  queue = [] as EventSummary[],
} = {}) {
  vi.mocked(usersApi.fetchCoordinators).mockResolvedValue(coordinators);
  vi.mocked(eventsApi.fetchMyEvents).mockResolvedValue(events);
  vi.mocked(eventsApi.fetchUnassignedQueue).mockResolvedValue(queue);
  const wrapper = mount(LeadDashboardView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LeadDashboardView — assignment overview", () => {
  it("shows a card per coordinator, busiest first, including one with nothing assigned", async () => {
    const wrapper = await mountView({ events: [...eventsFor(PRIYA, 4, 1), ...eventsFor(AISHA, 2, 10)] });

    const cards = wrapper.findAll(".coordinator-card");
    expect(cards.map((c) => c.find(".coordinator-name").text())).toEqual(["Priya Nair", "Aisha Rahman", "Joel Chua"]);
    expect(cards[0].find(".avatar").text()).toBe("PN");
    expect(cards[0].text()).toContain("4 active events");
    expect(cards[2].text()).toContain("0 active events");
    expect(cards[2].text()).toContain("No active events assigned. Available for new work.");
  });

  it("shows the totals in the subtitle", async () => {
    const wrapper = await mountView({ events: [...eventsFor(PRIYA, 4, 1), ...eventsFor(AISHA, 2, 10)] });

    expect(wrapper.find(".subheading").text()).toContain("3 coordinators, 6 active events.");
  });

  it("shows the 3 soonest events with date, venue and status, and View all only above 3", async () => {
    const wrapper = await mountView({ events: [...eventsFor(PRIYA, 4, 1), ...eventsFor(AISHA, 2, 10)] });

    const [priya, aisha] = wrapper.findAll(".coordinator-card");
    const rows = priya.findAll(".row--link");
    expect(rows.map((r) => r.find(".cell-event__name").text())).toEqual([
      "Priya Nair event 1",
      "Priya Nair event 2",
      "Priya Nair event 3",
    ]);
    // A plain list, not a table: name, a date and venue line, and the status badge (no venue in the fixture).
    expect(rows[0].find(".row__details").text()).toBe("1 Nov · Not set");
    expect(rows[0].find(".badge").text()).toBe("Planning");
    expect(priya.find(".cell-header").exists()).toBe(false);
    expect(rows[0].attributes("href")).toBe("/events/1");

    const viewAll = priya.find(".view-all");
    expect(viewAll.text()).toBe("View all 4 events");
    expect(viewAll.attributes("href")).toBe("/lead/coordinators/COORD-0001");
    expect(aisha.find(".view-all").exists()).toBe(false);
  });

  it("leaves out closed, draft and unassigned events", async () => {
    const wrapper = await mountView({
      events: [
        makeEvent({ id: 1, status: "Requested" }),
        makeEvent({ id: 2, status: "Completed" }),
        makeEvent({ id: 3, status: "Cancelled" }),
        makeEvent({ id: 4, status: "Rejected" }),
        makeEvent({ id: 5, status: "Unassigned", coordinator_id: null, coordinator: null }),
      ],
    });

    expect(wrapper.findAll(".coordinator-card")[0].findAll(".row--link")).toHaveLength(1);
  });

  it("links Assign event to the unassigned queue, with its count", async () => {
    const wrapper = await mountView({ queue: [makeEvent({ status: "Unassigned" }), makeEvent({ id: 2, status: "Unassigned" })] });

    const button = wrapper.find(".btn-primary");
    expect(button.text()).toBe("Assign event (2)");
    expect(button.attributes("href")).toBe("/lead/unassigned");
  });

  it("drops the count when nothing is waiting", async () => {
    const wrapper = await mountView();

    expect(wrapper.find(".btn-primary").text()).toBe("Assign event");
  });

  it("has no search field, progress bar or workload tag", async () => {
    const wrapper = await mountView({ events: eventsFor(PRIYA, 7, 1) });

    expect(wrapper.find("input").exists()).toBe(false);
    expect(wrapper.find("[role='progressbar'], progress").exists()).toBe(false);
    expect(wrapper.text()).not.toMatch(/Heavy|Balanced|Light/);
  });

  it("shows an error when loading fails", async () => {
    vi.mocked(usersApi.fetchCoordinators).mockRejectedValue(new Error("boom"));
    vi.mocked(eventsApi.fetchMyEvents).mockResolvedValue([]);
    vi.mocked(eventsApi.fetchUnassignedQueue).mockResolvedValue([]);
    const wrapper = mount(LeadDashboardView, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.find("[role='alert']").text()).toContain("We couldn't load the assignments.");
  });
});
