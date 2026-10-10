import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createRouter, createMemoryHistory } from "vue-router";
import CoordinatorWorkloadView from "../CoordinatorWorkloadView.vue";
import * as eventsApi from "../../lib/eventsApi";

vi.mock("../../lib/eventsApi", () => ({
  fetchMyEvents: vi.fn(),
  getCurrentUser: vi.fn(),
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
    status: "Requested",
    submitted_details: { name: "Test Event", proposedDate: "2099-06-15" },
    coordinator_id: "COORD-0001",
    coordinator: { name: "Alice Coord" },
    organiser: { name: "Bob Org" },
    review_outcome: null,
    decided_at: null,
    decided_by: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

async function mountView(events: EventSummary[], userId = "COORD-0001") {
  vi.mocked(eventsApi.fetchMyEvents).mockResolvedValue(events);
  vi.mocked(eventsApi.getCurrentUser).mockResolvedValue({ id: userId, role: "coordinator" });

  const wrapper = mount(CoordinatorWorkloadView, {
    global: { plugins: [router] },
  });

  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CoordinatorWorkloadView — loading & error states", () => {
  it("shows a loading message before the API resolves", () => {
    vi.mocked(eventsApi.fetchMyEvents).mockReturnValue(new Promise(() => {}));
    vi.mocked(eventsApi.getCurrentUser).mockReturnValue(new Promise(() => {}));

    const wrapper = mount(CoordinatorWorkloadView, {
      global: { plugins: [router] },
    });

    expect(wrapper.text()).toContain("Loading events");
  });

  it("shows an error message when the API call fails", async () => {
    vi.mocked(eventsApi.fetchMyEvents).mockRejectedValue(new Error("Network error"));
    vi.mocked(eventsApi.getCurrentUser).mockResolvedValue({ id: "COORD-0001", role: "coordinator" });

    const wrapper = mount(CoordinatorWorkloadView, {
      global: { plugins: [router] },
    });
    await flushPromises();

    expect(wrapper.text()).toContain("couldn't load");
  });

  it("shows an empty-state message when the coordinator has no assigned events", async () => {
    const wrapper = await mountView([]);

    expect(wrapper.text()).toContain("No events are assigned to you yet");
  });
});

describe("CoordinatorWorkloadView — My events mode (default)", () => {
  it("only shows events assigned to the current coordinator", async () => {
    const events = [
      makeEvent({ id: 1, coordinator_id: "COORD-0001" }),
      makeEvent({ id: 2, coordinator_id: "COORD-0002", organiser: { name: "Other Org" } }),
    ];
    const wrapper = await mountView(events, "COORD-0001");

    const cards = wrapper.findAll(".event-card");
    expect(cards).toHaveLength(1);
  });

  it("includes Unassigned events so the coordinator can self-assign them", async () => {
    const events = [
      makeEvent({ id: 1, coordinator_id: "COORD-0001" }),
      makeEvent({ id: 2, status: "Unassigned", coordinator_id: null, coordinator: null }),
    ];
    const wrapper = await mountView(events, "COORD-0001");

    const cards = wrapper.findAll(".event-card");
    expect(cards).toHaveLength(2);
  });

  it("excludes events assigned to a different coordinator", async () => {
    const events = [
      makeEvent({ id: 1, coordinator_id: "COORD-0099", status: "Planning" }),
    ];
    const wrapper = await mountView(events, "COORD-0001");

    expect(wrapper.findAll(".event-card")).toHaveLength(0);
    expect(wrapper.text()).toContain("No events are assigned to you yet");
  });

  it("shows 'Requested by' with the organiser's name on each card", async () => {
    const wrapper = await mountView([
      makeEvent({ organiser: { name: "Sam Organiser" } }),
    ]);

    expect(wrapper.text()).toContain("Requested by: Sam Organiser");
  });

  it("lists events flat in status-priority order with no section headers", async () => {
    const events = [
      makeEvent({ id: 1, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: "2099-01-01" } }),
      makeEvent({ id: 2, status: "Requested", submitted_details: { name: "Review Event", proposedDate: "2099-09-01" } }),
    ];
    const wrapper = await mountView(events);

    expect(wrapper.findAll(".group-label")).toHaveLength(0);
    expect(wrapper.findAll(".status-group")).toHaveLength(0);
    const cards = wrapper.findAll(".event-card");
    expect(cards[0].text()).toContain("Review Event");
    expect(cards[1].text()).toContain("Plan Event");
  });

  it("sorts events within a group by proposedDate ascending", async () => {
    const events = [
      makeEvent({ id: 1, submitted_details: { proposedDate: "2099-12-01" }, organiser: { name: "Late Event" } }),
      makeEvent({ id: 2, submitted_details: { proposedDate: "2099-03-01" }, organiser: { name: "Early Event" } }),
    ];
    const wrapper = await mountView(events);

    const cards = wrapper.findAll(".event-card");
    expect(cards[0].text()).toContain("Early Event");
    expect(cards[1].text()).toContain("Late Event");
  });

  it("marks only cards that wait on the coordinator with the accent bar class", async () => {
    const events = [
      makeEvent({ id: 1, status: "Requested" }),
      makeEvent({ id: 2, status: "Unassigned", coordinator_id: null, coordinator: null }),
      makeEvent({ id: 3, status: "Planning" }),
    ];
    const wrapper = await mountView(events);

    expect(wrapper.findAll(".event-card")).toHaveLength(3);
    expect(wrapper.findAll(".event-card--needs-action")).toHaveLength(2);
    expect(wrapper.findAll(".event-card--action")).toHaveLength(0);
  });
});

describe("CoordinatorWorkloadView — status tabs", () => {
  const tabEvents = () => [
    makeEvent({ id: 1, status: "Requested" }),
    makeEvent({ id: 2, status: "Unassigned", coordinator_id: null, coordinator: null }),
    makeEvent({ id: 3, status: "Planning" }),
  ];

  it("renders an All tab plus one tab per non-empty group, with counts", async () => {
    const wrapper = await mountView(tabEvents());

    const tabs = wrapper.findAll("[role='tab']").map((t) => t.text().replace(/\s+/g, " "));
    expect(tabs).toEqual(["All 3", "Needs Review 2", "Planning 1"]);
  });

  it("defaults to All and shows every event in one flat grid", async () => {
    const wrapper = await mountView(tabEvents());

    expect(wrapper.find(".tab--active").text()).toContain("All");
    expect(wrapper.findAll(".card-grid")).toHaveLength(1);
    expect(wrapper.findAll(".event-card")).toHaveLength(3);
  });

  it("filters cards to one status group when its tab is selected", async () => {
    const wrapper = await mountView(tabEvents());

    await wrapper.findAll("[role='tab']")[2].trigger("click");

    expect(wrapper.find(".tab--active").text()).toContain("Planning");
    expect(wrapper.findAll(".event-card")).toHaveLength(1);
    expect(wrapper.findAll(".group-label")).toHaveLength(0);
  });

  it("falls back to All when the selected tab empties after switching scope", async () => {
    const events = [
      makeEvent({ id: 1, status: "Requested" }),
      makeEvent({ id: 2, status: "Planning", coordinator_id: "COORD-0002" }),
    ];
    const wrapper = await mountView(events);

    await wrapper.findAll(".toggle-btn")[1].trigger("click"); // All events
    await wrapper.findAll("[role='tab']")[2].trigger("click"); // Planning
    expect(wrapper.findAll(".event-card")).toHaveLength(1);

    await wrapper.findAll(".toggle-btn")[0].trigger("click"); // back to My events
    expect(wrapper.find(".tab--active").text()).toContain("All");
    expect(wrapper.findAll(".event-card")).toHaveLength(1);
  });
});

describe("CoordinatorWorkloadView — All events mode", () => {
  it("shows all events including those assigned to other coordinators", async () => {
    const events = [
      makeEvent({ id: 1, coordinator_id: "COORD-0001" }),
      makeEvent({ id: 2, coordinator_id: "COORD-0002", status: "Planning" }),
    ];
    const wrapper = await mountView(events, "COORD-0001");

    await wrapper.find(".toggle-btn:last-child").trigger("click");
    await flushPromises();

    expect(wrapper.findAll(".event-card")).toHaveLength(2);
  });

  it("shows 'Coordinator: X' on each card instead of organiser", async () => {
    const wrapper = await mountView([
      makeEvent({ coordinator: { name: "Alice Coord" } }),
    ], "COORD-0001");

    await wrapper.find(".toggle-btn:last-child").trigger("click");

    expect(wrapper.text()).toContain("Coordinator: Alice Coord");
    expect(wrapper.text()).not.toContain("Requested by:");
  });

  it("shows 'Coordinator: Unassigned' when an event has no coordinator", async () => {
    const wrapper = await mountView([
      makeEvent({ status: "Unassigned", coordinator_id: null, coordinator: null }),
    ]);

    await wrapper.find(".toggle-btn:last-child").trigger("click");

    expect(wrapper.text()).toContain("Coordinator: Unassigned");
  });

  it("shows an empty-state message when the system has no events at all", async () => {
    const wrapper = await mountView([]);

    await wrapper.find(".toggle-btn:last-child").trigger("click");

    expect(wrapper.text()).toContain("No events in the system yet");
  });

  it("updates the page heading when switching to all-events view", async () => {
    const wrapper = await mountView([makeEvent()]);

    await wrapper.find(".toggle-btn:last-child").trigger("click");

    expect(wrapper.find(".h2").text()).toBe("All events");
  });
});

describe("CoordinatorWorkloadView — view toggle", () => {
  it("defaults to My events mode", async () => {
    const wrapper = await mountView([]);

    expect(wrapper.find(".h2").text()).toBe("My workload");
    expect(wrapper.find(".toggle-btn--active").text()).toBe("My events");
  });

  it("switches to All events mode when the toggle is clicked", async () => {
    const wrapper = await mountView([makeEvent()]);

    await wrapper.find(".toggle-btn:last-child").trigger("click");

    expect(wrapper.find(".h2").text()).toBe("All events");
    expect(wrapper.find(".toggle-btn--active").text()).toBe("All events");
  });

  it("switches back to My events mode when clicked again", async () => {
    const wrapper = await mountView([makeEvent()]);

    await wrapper.find(".toggle-btn:last-child").trigger("click");
    await wrapper.find(".toggle-btn:first-child").trigger("click");

    expect(wrapper.find(".h2").text()).toBe("My workload");
  });
});
