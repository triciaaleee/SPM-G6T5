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

async function mountView(
  events: EventSummary[],
  userId = "COORD-0001",
  scope: "mine" | "all" = "mine",
  role = "coordinator",
) {
  vi.mocked(eventsApi.fetchMyEvents).mockResolvedValue(events);
  vi.mocked(eventsApi.getCurrentUser).mockResolvedValue({ id: userId, role });

  const wrapper = mount(CoordinatorWorkloadView, {
    props: { scope },
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

  it("shows the date and time on separate lines, with a thumbnail, on each card", async () => {
    const wrapper = await mountView([
      makeEvent({
        submitted_details: { name: "Gala", proposedDate: "2099-06-15", startTime: "18:00", endTime: "21:00" },
      }),
    ]);

    const facts = wrapper.findAll(".event-card .fact").map((f) => f.text());
    expect(facts).toEqual(["15 Jun 2099", "6:00 PM to 9:00 PM"]);
    expect(wrapper.find(".event-card .card-thumbnail").exists()).toBe(true);
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

  it("marks only Requested cards with the accent bar class, not Unassigned (the Lead's to assign)", async () => {
    const events = [
      makeEvent({ id: 1, status: "Requested" }),
      makeEvent({ id: 2, status: "Unassigned", coordinator_id: null, coordinator: null }),
      makeEvent({ id: 3, status: "Planning" }),
    ];
    const wrapper = await mountView(events, "COORD-0001", "all");

    expect(wrapper.findAll(".event-card")).toHaveLength(3);
    expect(wrapper.findAll(".event-card--needs-action")).toHaveLength(1);
    expect(wrapper.findAll(".event-card--action")).toHaveLength(0);
  });
});

describe("CoordinatorWorkloadView — status tabs", () => {
  const tabEvents = () => [
    makeEvent({ id: 1, status: "Requested" }),
    makeEvent({ id: 2, status: "Requested" }),
    makeEvent({ id: 3, status: "Planning" }),
  ];

  it("gives Unassigned events their own tab under All events", async () => {
    const wrapper = await mountView(
      [
        makeEvent({ id: 1, status: "Requested" }),
        makeEvent({ id: 2, status: "Unassigned", coordinator_id: null, coordinator: null }),
      ],
      "COORD-0001",
      "all",
    );

    const tabs = wrapper.findAll("[role='tab']").map((t) => t.text().replace(/\s+/g, " "));
    expect(tabs).toEqual(["Active 2", "All 2", "Awaiting Review 1", "Unassigned 1"]);
  });

  it("renders Active and All tabs plus one tab per non-empty group, with counts", async () => {
    const wrapper = await mountView(tabEvents());

    const tabs = wrapper.findAll("[role='tab']").map((t) => t.text().replace(/\s+/g, " "));
    expect(tabs).toEqual(["Active 3", "All 3", "Awaiting Review 2", "Planning 1"]);
  });

  it("defaults to Active and shows every open event in one flat grid", async () => {
    const wrapper = await mountView(tabEvents());

    expect(wrapper.find(".tab--active").text()).toContain("Active");
    expect(wrapper.findAll(".card-grid")).toHaveLength(1);
    expect(wrapper.findAll(".event-card")).toHaveLength(3);
  });

  it("filters cards to one status group when its tab is selected", async () => {
    const wrapper = await mountView(tabEvents());

    await wrapper.findAll("[role='tab']")[3].trigger("click");

    expect(wrapper.find(".tab--active").text()).toContain("Planning");
    expect(wrapper.findAll(".event-card")).toHaveLength(1);
    expect(wrapper.findAll(".group-label")).toHaveLength(0);
  });
});

describe("CoordinatorWorkloadView — Active list (E3-5 AC1)", () => {
  const mixedEvents = () => [
    makeEvent({ id: 1, status: "Confirmed", submitted_details: { name: "Confirmed Event", proposedDate: "2099-01-01" } }),
    makeEvent({ id: 2, status: "Completed", submitted_details: { name: "Completed Event", proposedDate: "2099-01-02" } }),
    makeEvent({ id: 3, status: "Rejected", submitted_details: { name: "Rejected Event", proposedDate: "2099-01-03" } }),
    makeEvent({ id: 4, status: "Cancelled", submitted_details: { name: "Cancelled Event", proposedDate: "2099-01-04" } }),
    makeEvent({ id: 5, status: "Safety Review", submitted_details: { name: "Safety Event", proposedDate: "2099-01-05" } }),
  ];

  function cardTitles(wrapper: Awaited<ReturnType<typeof mountView>>) {
    return wrapper.findAll(".event-card .card-title").map((c) => c.text());
  }

  it("leaves Completed, Rejected and Cancelled events out of the default Active tab", async () => {
    const wrapper = await mountView(mixedEvents());

    expect(cardTitles(wrapper)).toEqual(["Safety Event", "Confirmed Event"]);
  });

  it("still lists them under All, so the record isn't lost", async () => {
    const wrapper = await mountView(mixedEvents());
    await wrapper.findAll("[role='tab']")[1].trigger("click");

    expect(cardTitles(wrapper)).toHaveLength(5);
    expect(cardTitles(wrapper)).toContain("Completed Event");
  });

  it("gives Safety Review and Cancelled events their own tabs, so none go missing", async () => {
    const wrapper = await mountView(mixedEvents());

    const tabs = wrapper.findAll("[role='tab']").map((t) => t.text().replace(/\s+/g, " "));
    expect(tabs).toEqual([
      "Active 2",
      "All 5",
      "Safety Review 1",
      "Confirmed 1",
      "Completed 1",
      "Rejected 1",
      "Cancelled 1",
    ]);
  });

  it("opens a closed group's tab on request", async () => {
    const wrapper = await mountView(mixedEvents());
    await wrapper.findAll("[role='tab']").find((t) => t.text().startsWith("Completed"))!.trigger("click");

    expect(cardTitles(wrapper)).toEqual(["Completed Event"]);
  });

  it("says where to look when every event is closed", async () => {
    const wrapper = await mountView([makeEvent({ id: 2, status: "Completed" })]);

    expect(wrapper.findAll(".event-card")).toHaveLength(0);
    expect(wrapper.text()).toContain("No active events. Completed, rejected and cancelled events are under All.");
  });
});

describe("CoordinatorWorkloadView — All events page", () => {
  it("shows all events including those assigned to other coordinators", async () => {
    const events = [
      makeEvent({ id: 1, coordinator_id: "COORD-0001" }),
      makeEvent({ id: 2, coordinator_id: "COORD-0002", status: "Planning" }),
    ];
    const wrapper = await mountView(events, "COORD-0001", "all");

    expect(wrapper.findAll(".event-card")).toHaveLength(2);
  });

  it("shows 'Coordinator: X' on each card instead of organiser", async () => {
    const wrapper = await mountView([makeEvent({ coordinator: { name: "Alice Coord" } })], "COORD-0001", "all");

    expect(wrapper.text()).toContain("Coordinator: Alice Coord");
    expect(wrapper.text()).not.toContain("Requested by:");
  });

  it("shows 'Coordinator: Unassigned' when an event has no coordinator", async () => {
    const wrapper = await mountView(
      [makeEvent({ status: "Unassigned", coordinator_id: null, coordinator: null })],
      "COORD-0001",
      "all",
    );

    expect(wrapper.text()).toContain("Coordinator: Unassigned");
  });

  it("shows an empty-state message when the system has no events at all", async () => {
    const wrapper = await mountView([], "COORD-0001", "all");

    expect(wrapper.text()).toContain("No events in the system yet");
  });

  it("has the All events heading and no My/All toggle", async () => {
    const wrapper = await mountView([makeEvent()], "COORD-0001", "all");

    expect(wrapper.find(".h2").text()).toBe("All events");
    expect(wrapper.find(".toggle-btn").exists()).toBe(false);
  });

  it("flags only the signed-in coordinator's own Requested events, and none for the Lead", async () => {
    const events = [
      makeEvent({ id: 1, status: "Requested", coordinator_id: "COORD-0001" }),
      makeEvent({ id: 2, status: "Requested", coordinator_id: "COORD-0002" }),
    ];

    const coordinatorView = await mountView(events, "COORD-0001", "all");
    expect(coordinatorView.findAll(".event-card--needs-action")).toHaveLength(1);

    const leadView = await mountView(events, "LEAD-0001", "all", "coordinator_lead");
    expect(leadView.findAll(".event-card")).toHaveLength(2);
    expect(leadView.findAll(".event-card--needs-action")).toHaveLength(0);
  });
});

describe("CoordinatorWorkloadView — My events page", () => {
  it("defaults to My events and has no toggle", async () => {
    const wrapper = await mountView([]);

    expect(wrapper.find(".h2").text()).toBe("My events");
    expect(wrapper.find(".toggle-btn").exists()).toBe(false);
  });

  it("only lists events assigned to the signed-in coordinator", async () => {
    const wrapper = await mountView([
      makeEvent({ id: 1, coordinator_id: "COORD-0001" }),
      makeEvent({ id: 2, coordinator_id: "COORD-0002" }),
    ]);

    expect(wrapper.findAll(".event-card")).toHaveLength(1);
  });
});
