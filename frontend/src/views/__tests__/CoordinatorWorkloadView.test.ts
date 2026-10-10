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

  it("leaves Unassigned events out — only events assigned to me (E1-8 AC4)", async () => {
    const events = [
      makeEvent({ id: 1, coordinator_id: "COORD-0001" }),
      makeEvent({ id: 2, status: "Unassigned", coordinator_id: null, coordinator: null }),
    ];
    const wrapper = await mountView(events, "COORD-0001");

    const cards = wrapper.findAll(".event-card");
    expect(cards).toHaveLength(1);
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

  it("groups events under the correct status section header", async () => {
    const events = [
      makeEvent({ id: 1, status: "Requested" }),
      makeEvent({ id: 2, status: "Planning" }),
    ];
    const wrapper = await mountView(events);

    const groupHeaders = wrapper.findAll(".group-label");
    const labels = groupHeaders.map((h) => h.text());
    expect(labels).toContain("Needs Review");
    expect(labels).toContain("Planning");
  });

  it("shows Unassigned events under All events in their own group, not Needs Review", async () => {
    const events = [
      makeEvent({ id: 1, status: "Requested" }),
      makeEvent({ id: 2, status: "Unassigned", coordinator_id: null, coordinator: null }),
    ];
    const wrapper = await mountView(events);
    await wrapper.findAll(".toggle-btn")[1].trigger("click");

    const sections = wrapper.findAll(".status-group");
    expect(sections[0].text()).toContain("Needs Review");
    expect(sections[0].findAll(".event-card")).toHaveLength(1);
    expect(sections[1].text()).toContain("Unassigned");
    expect(sections[1].findAll(".event-card--action")).toHaveLength(0);
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

  it("applies the action highlight class to Requested cards only", async () => {
    const events = [
      makeEvent({ id: 1, status: "Requested" }),
      makeEvent({ id: 3, status: "Planning" }),
    ];
    const wrapper = await mountView(events);

    const actionCards = wrapper.findAll(".event-card--action");
    const normalCards = wrapper.findAll(".event-card:not(.event-card--action)");

    expect(actionCards).toHaveLength(1);
    expect(normalCards).toHaveLength(1);
  });

  it("does not show a status group section when no events belong to it", async () => {
    const wrapper = await mountView([makeEvent({ status: "Requested" })]);

    const groupLabels = wrapper.findAll(".group-label").map((el) => el.text());
    expect(groupLabels).not.toContain("Planning");
    expect(groupLabels).not.toContain("Completed");
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
