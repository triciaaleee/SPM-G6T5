import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createRouter, createMemoryHistory } from "vue-router";
import CoordinatorWorkloadView from "../CoordinatorWorkloadView.vue";
import * as eventsApi from "../../../lib/eventsApi";

vi.mock("../../../lib/eventsApi", () => ({
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

// Far enough in the future/past that hasEventEnded reads them as Upcoming/Past respectively.
const FUTURE_DATE = "2099-06-15";
const PAST_DATE = "2000-01-01";

function makeEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: 1,
    status: "Requested",
    submitted_details: { name: "Test Event", proposedDate: FUTURE_DATE },
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

function rowTitles(wrapper: Awaited<ReturnType<typeof mountView>>) {
  return wrapper.findAll(".cell-event__title").map((c) => c.text());
}

function statusFilterLabel(wrapper: Awaited<ReturnType<typeof mountView>>) {
  return wrapper.find("#status-filter").text();
}

/** Opens the status popover and clicks the option whose visible text starts with `label`. */
async function selectStatus(wrapper: Awaited<ReturnType<typeof mountView>>, label: string) {
  await wrapper.find("#status-filter").trigger("click");
  await wrapper.findAll(".status-filter__option").find((o) => o.text().startsWith(label))!.trigger("click");
}

/** Clicks the timing tab whose label starts with `label` (Upcoming, To Complete, Past). */
async function clickTab(wrapper: Awaited<ReturnType<typeof mountView>>, label: string) {
  await wrapper.findAll("[role='tab']").find((t) => t.text().startsWith(label))!.trigger("click");
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

    expect(rowTitles(wrapper)).toHaveLength(1);
  });

  it("leaves Unassigned events out — only events assigned to me (E1-8 AC4)", async () => {
    const events = [
      makeEvent({ id: 1, coordinator_id: "COORD-0001" }),
      makeEvent({ id: 2, status: "Unassigned", coordinator_id: null, coordinator: null }),
    ];
    const wrapper = await mountView(events, "COORD-0001");

    expect(rowTitles(wrapper)).toHaveLength(1);
  });

  it("excludes events assigned to a different coordinator", async () => {
    const events = [makeEvent({ id: 1, coordinator_id: "COORD-0099", status: "Planning" })];
    const wrapper = await mountView(events, "COORD-0001");

    expect(rowTitles(wrapper)).toHaveLength(0);
    expect(wrapper.text()).toContain("No events are assigned to you yet");
  });

  it("shows a 'Requested by' column with the organiser's name on each row", async () => {
    const wrapper = await mountView([makeEvent({ organiser: { name: "Sam Organiser" } })]);

    expect(wrapper.find(".cell-header").text()).toBe("Event");
    expect(wrapper.findAll(".cell-header").map((h) => h.text())).toContain("Requested by");
    expect(wrapper.find(".cell-person").text()).toBe("Sam Organiser");
  });

  it("shows the date and time in their own columns for each row", async () => {
    const wrapper = await mountView([
      makeEvent({
        submitted_details: { name: "Gala", proposedDate: FUTURE_DATE, startTime: "18:00", endTime: "21:00" },
      }),
    ]);

    expect(wrapper.find(".cell-date").text()).toBe("15 Jun 2099");
    expect(wrapper.find(".cell-time").text()).toBe("6:00 PM to 9:00 PM");
  });
});

describe("CoordinatorWorkloadView — Upcoming / Past tabs", () => {
  it("defaults to Upcoming and splits events by whether they've ended", async () => {
    const events = [
      makeEvent({ id: 1, submitted_details: { name: "Future Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, submitted_details: { name: "Past Event", proposedDate: PAST_DATE } }),
    ];
    const wrapper = await mountView(events);

    const tabs = wrapper.findAll("[role='tab']").map((t) => t.text().replace(/\s+/g, " "));
    expect(tabs).toEqual(["Upcoming 1", "To Complete 0", "Past 1"]);
    expect(wrapper.find(".tab--active").text()).toContain("Upcoming");
    expect(rowTitles(wrapper)).toEqual(["Future Event"]);
  });

  it("switches to the Past tab on click", async () => {
    const events = [
      makeEvent({ id: 1, submitted_details: { name: "Future Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, submitted_details: { name: "Past Event", proposedDate: PAST_DATE } }),
    ];
    const wrapper = await mountView(events);

    await clickTab(wrapper, "Past");

    expect(wrapper.find(".tab--active").text()).toContain("Past");
    expect(rowTitles(wrapper)).toEqual(["Past Event"]);
  });

  it("includes closed-status events in their timing tab rather than hiding them", async () => {
    const events = [
      makeEvent({ id: 1, status: "Completed", submitted_details: { name: "Completed Event", proposedDate: PAST_DATE } }),
      makeEvent({ id: 2, status: "Cancelled", submitted_details: { name: "Cancelled Event", proposedDate: PAST_DATE } }),
    ];
    const wrapper = await mountView(events);

    await clickTab(wrapper, "Past");

    expect(rowTitles(wrapper)).toEqual(["Completed Event", "Cancelled Event"]);
  });

  it("says when nothing matches the current tab and filter", async () => {
    const wrapper = await mountView([
      makeEvent({ submitted_details: { name: "Future Event", proposedDate: FUTURE_DATE } }),
    ]);

    await clickTab(wrapper, "Past");

    expect(wrapper.text()).toContain("No events match this tab and filter");
  });
});

describe("CoordinatorWorkloadView — status filter dropdown", () => {
  it("defaults to All statuses and shows every event in the active tab", async () => {
    const events = [
      makeEvent({ id: 1, status: "Requested", submitted_details: { name: "Req Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
    ];
    const wrapper = await mountView(events);

    expect(statusFilterLabel(wrapper)).toContain("All statuses");
    expect(rowTitles(wrapper)).toHaveLength(2);
  });

  it("narrows the list to the selected status", async () => {
    const events = [
      makeEvent({ id: 1, status: "Requested", submitted_details: { name: "Req Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
    ];
    const wrapper = await mountView(events);

    await selectStatus(wrapper, "Planning");

    expect(rowTitles(wrapper)).toEqual(["Plan Event"]);
  });

  it("groups its options under the same who-acts-next sections as the table, and hides statuses with no events", async () => {
    const wrapper = await mountView([
      makeEvent({ status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
    ]);

    await wrapper.find("#status-filter").trigger("click");

    const sectionLabels = wrapper.findAll(".status-filter__section-label").map((s) => s.text());
    expect(sectionLabels).toEqual(["NEEDS YOUR ACTION"]);
    expect(wrapper.findAll(".status-filter__option").map((o) => o.text().replace(/\s+/g, " "))).toEqual([
      "All statuses",
      "Planning",
    ]);
  });

  it("shows a checkmark only on the selected option, and updates the trigger label", async () => {
    const wrapper = await mountView([
      makeEvent({ status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
    ]);

    await selectStatus(wrapper, "Planning");
    expect(statusFilterLabel(wrapper)).toBe("Planning");

    await wrapper.find("#status-filter").trigger("click");
    expect(wrapper.findAll(".status-filter__option--selected").map((o) => o.text())).toEqual(["Planning"]);
  });

  it("closes when clicking outside, without changing the filter", async () => {
    const wrapper = await mountView([
      makeEvent({ status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
    ]);

    await wrapper.find("#status-filter").trigger("click");
    expect(wrapper.find(".status-filter__popover").exists()).toBe(true);

    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".status-filter__popover").exists()).toBe(false);
    expect(statusFilterLabel(wrapper)).toContain("All statuses");
  });
});

describe("CoordinatorWorkloadView — Needs Review row highlight", () => {
  it("highlights only rows whose event is Needs Review", async () => {
    const events = [
      makeEvent({ id: 1, status: "Needs Review", submitted_details: { name: "Review Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, status: "Requested", submitted_details: { name: "Requested Event", proposedDate: FUTURE_DATE } }),
    ];
    const wrapper = await mountView(events);

    expect(wrapper.findAll(".row--needs-review")).toHaveLength(1);
    expect(wrapper.find(".row--needs-review").text()).toContain("Review Event");
  });
});

describe("CoordinatorWorkloadView — All events page", () => {
  it("shows all events including those assigned to other coordinators", async () => {
    const events = [
      makeEvent({ id: 1, coordinator_id: "COORD-0001" }),
      makeEvent({ id: 2, coordinator_id: "COORD-0002", status: "Planning" }),
    ];
    const wrapper = await mountView(events, "COORD-0001", "all");

    expect(rowTitles(wrapper)).toHaveLength(2);
  });

  it("shows a 'Coordinator' column with the coordinator's name instead of organiser", async () => {
    const wrapper = await mountView([makeEvent({ coordinator: { name: "Alice Coord" } })], "COORD-0001", "all");

    expect(wrapper.findAll(".cell-header").map((h) => h.text())).toContain("Coordinator");
    expect(wrapper.findAll(".cell-header").map((h) => h.text())).not.toContain("Requested by");
    expect(wrapper.find(".cell-person").text()).toBe("Alice Coord");
  });

  it("shows 'Unassigned' in the Coordinator column when an event has no coordinator", async () => {
    const wrapper = await mountView(
      [makeEvent({ status: "Unassigned", coordinator_id: null, coordinator: null })],
      "COORD-0001",
      "all",
    );

    expect(wrapper.find(".cell-person").text()).toBe("Unassigned");
  });

  it("shows an empty-state message when the system has no events at all", async () => {
    const wrapper = await mountView([], "COORD-0001", "all");

    expect(wrapper.text()).toContain("No events in the system yet");
  });

  it("has the All events heading", async () => {
    const wrapper = await mountView([makeEvent()], "COORD-0001", "all");

    expect(wrapper.find(".h2").text()).toBe("All events");
  });
});

describe("CoordinatorWorkloadView — who-acts-next groups (My events, Upcoming, All statuses)", () => {
  function groupHeaders(wrapper: Awaited<ReturnType<typeof mountView>>) {
    return wrapper.findAll(".group-header").map((h) => `${h.find(".group-header__title").text()} ${h.find(".group-header__badge").text()}`);
  }

  it("groups Upcoming events by who acts next, with a title and count but no subtitle", async () => {
    const events = [
      makeEvent({ id: 1, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, status: "Safety Review", submitted_details: { name: "Safety Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 3, status: "Confirmed", submitted_details: { name: "Confirmed Event", proposedDate: FUTURE_DATE } }),
    ];
    const wrapper = await mountView(events);

    expect(groupHeaders(wrapper)).toEqual(["Needs your action 1", "Waiting on others 1", "On track 1"]);
    expect(wrapper.text()).not.toContain("You are the next person to act");
    expect(wrapper.text()).not.toContain("Waiting for");
  });

  it("puts Requested in Needs your action, not a separate or excluded bucket", async () => {
    const wrapper = await mountView([
      makeEvent({ status: "Requested", submitted_details: { name: "Req Event", proposedDate: FUTURE_DATE } }),
    ]);

    expect(groupHeaders(wrapper)).toEqual(["Needs your action 1"]);
  });

  it("omits empty groups", async () => {
    const wrapper = await mountView([
      makeEvent({ status: "Confirmed", submitted_details: { name: "Confirmed Event", proposedDate: FUTURE_DATE } }),
    ]);

    expect(groupHeaders(wrapper)).toEqual(["On track 1"]);
  });

  it("renders a chevron on every row", async () => {
    const wrapper = await mountView([
      makeEvent({ status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
    ]);

    expect(wrapper.findAll(".row-chevron")).toHaveLength(1);
  });

  it("collapses to a flat list with no group headers once a specific status is picked", async () => {
    const wrapper = await mountView([
      makeEvent({ status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, status: "Confirmed", submitted_details: { name: "Confirmed Event", proposedDate: FUTURE_DATE } }),
    ]);

    await selectStatus(wrapper, "Planning");

    expect(groupHeaders(wrapper)).toHaveLength(0);
    expect(rowTitles(wrapper)).toEqual(["Plan Event"]);
  });

  it("never groups the Past or To Complete tabs, on either page", async () => {
    const events = [
      makeEvent({ id: 1, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, status: "Completed", submitted_details: { name: "Completed Event", proposedDate: PAST_DATE } }),
      makeEvent({ id: 3, status: "Confirmed", submitted_details: { name: "Ended Event", proposedDate: PAST_DATE } }),
    ];
    for (const scope of ["mine", "all"] as const) {
      const wrapper = await mountView(events, "COORD-0001", scope);
      await clickTab(wrapper, "Past");
      expect(groupHeaders(wrapper)).toHaveLength(0);
      await clickTab(wrapper, "To Complete");
      expect(groupHeaders(wrapper)).toHaveLength(0);
    }
  });

  it("groups the All events page's Upcoming tab under the same sub-headers as My events", async () => {
    const events = [
      makeEvent({ id: 1, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, status: "Safety Review", submitted_details: { name: "Safety Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 3, status: "Confirmed", submitted_details: { name: "Confirmed Event", proposedDate: FUTURE_DATE } }),
    ];
    const mine = await mountView(events);
    const all = await mountView(events, "COORD-0001", "all");

    expect(groupHeaders(all)).toEqual(["Needs your action 1", "Waiting on others 1", "On track 1"]);
    expect(groupHeaders(all)).toEqual(groupHeaders(mine));
    expect(rowTitles(all)).toEqual(["Plan Event", "Safety Event", "Confirmed Event"]);
  });

  it("keeps an unassigned or future-dated dead request visible on All events, under an Other sub-header", async () => {
    const wrapper = await mountView(
      [
        makeEvent({ id: 1, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
        makeEvent({ id: 2, status: "Unassigned", coordinator_id: null, submitted_details: { name: "Unassigned Event", proposedDate: FUTURE_DATE } }),
        makeEvent({ id: 3, status: "Rejected", submitted_details: { name: "Rejected Event", proposedDate: FUTURE_DATE } }),
      ],
      "COORD-0001",
      "all",
    );

    expect(groupHeaders(wrapper)).toEqual(["Needs your action 1", "Other 2"]);
    expect(rowTitles(wrapper)).toEqual(["Plan Event", "Unassigned Event", "Rejected Event"]);
  });

  it("never shows an Other sub-header on My events, where those statuses can't be Upcoming", async () => {
    const wrapper = await mountView([
      makeEvent({ id: 1, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, status: "Rejected", submitted_details: { name: "Rejected Event", proposedDate: FUTURE_DATE } }),
    ]);

    expect(groupHeaders(wrapper)).toEqual(["Needs your action 1"]);
  });
});

describe("CoordinatorWorkloadView — quick-filter chips (My events, Upcoming)", () => {
  function chips(wrapper: Awaited<ReturnType<typeof mountView>>) {
    return wrapper.findAll(".chip").map((c) => c.text().replace(/\s+/g, " "));
  }

  function activeChip(wrapper: Awaited<ReturnType<typeof mountView>>) {
    return wrapper.find(".chip--active").text().replace(/\s+/g, " ");
  }

  it("shows an All chip plus one per group, with counts, on the Upcoming tab", async () => {
    const events = [
      makeEvent({ id: 1, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, status: "Confirmed", submitted_details: { name: "Confirmed Event", proposedDate: FUTURE_DATE } }),
    ];
    const wrapper = await mountView(events);

    expect(chips(wrapper)).toEqual(["All 2", "Needs your action 1", "Waiting on others 0", "On track 1"]);
    expect(activeChip(wrapper)).toBe("All 2");
  });

  it("hides the chip row on the Past and To Complete tabs", async () => {
    const wrapper = await mountView([
      makeEvent({ id: 1, status: "Completed", submitted_details: { name: "Completed Event", proposedDate: PAST_DATE } }),
      makeEvent({ id: 2, status: "Confirmed", submitted_details: { name: "Ended Event", proposedDate: PAST_DATE } }),
    ]);

    await clickTab(wrapper, "Past");
    expect(wrapper.findAll(".chip")).toHaveLength(0);
    await clickTab(wrapper, "To Complete");
    expect(wrapper.findAll(".chip")).toHaveLength(0);
  });

  it("shows the same chips on the All events page's Upcoming tab, with an Other chip only when needed", async () => {
    const all = await mountView(
      [makeEvent({ status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } })],
      "COORD-0001",
      "all",
    );
    expect(chips(all)).toEqual(["All 1", "Needs your action 1", "Waiting on others 0", "On track 0"]);

    const withOther = await mountView(
      [
        makeEvent({ id: 1, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
        makeEvent({ id: 2, status: "Unassigned", coordinator_id: null, submitted_details: { name: "Unassigned Event", proposedDate: FUTURE_DATE } }),
      ],
      "COORD-0001",
      "all",
    );
    expect(chips(withOther)).toEqual(["All 2", "Needs your action 1", "Waiting on others 0", "On track 0", "Other 1"]);
  });

  it("clicking a chip filters to that group and hides the inline group headers", async () => {
    const events = [
      makeEvent({ id: 1, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, status: "Confirmed", submitted_details: { name: "Confirmed Event", proposedDate: FUTURE_DATE } }),
    ];
    const wrapper = await mountView(events);

    const chipButtons = wrapper.findAll(".chip");
    await chipButtons.find((c) => c.text().startsWith("Needs your action"))!.trigger("click");

    expect(rowTitles(wrapper)).toEqual(["Plan Event"]);
    expect(wrapper.findAll(".group-header")).toHaveLength(0);
  });

  it("picking a chip resets the status dropdown back to All statuses", async () => {
    const wrapper = await mountView([
      makeEvent({ status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
    ]);

    await selectStatus(wrapper, "Planning");
    const chipButtons = wrapper.findAll(".chip");
    await chipButtons.find((c) => c.text().startsWith("On track"))!.trigger("click");

    expect(statusFilterLabel(wrapper)).toContain("All statuses");
  });

  it("picking a status in the dropdown resets the active chip back to All", async () => {
    const wrapper = await mountView([
      makeEvent({ id: 1, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, status: "Confirmed", submitted_details: { name: "Confirmed Event", proposedDate: FUTURE_DATE } }),
    ]);

    await wrapper.findAll(".chip").find((c) => c.text().startsWith("Needs your action"))!.trigger("click");
    await selectStatus(wrapper, "Confirmed");

    expect(activeChip(wrapper)).toBe("All 2");
  });

  it("chip counts reflect the whole Upcoming tab regardless of which chip or status is active", async () => {
    const events = [
      makeEvent({ id: 1, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, status: "Confirmed", submitted_details: { name: "Confirmed Event", proposedDate: FUTURE_DATE } }),
    ];
    const wrapper = await mountView(events);

    await wrapper.findAll(".chip").find((c) => c.text().startsWith("On track"))!.trigger("click");

    expect(chips(wrapper)).toEqual(["All 2", "Needs your action 1", "Waiting on others 0", "On track 1"]);
  });

  it("the All chip restores the grouped view", async () => {
    const events = [
      makeEvent({ id: 1, status: "Planning", submitted_details: { name: "Plan Event", proposedDate: FUTURE_DATE } }),
      makeEvent({ id: 2, status: "Confirmed", submitted_details: { name: "Confirmed Event", proposedDate: FUTURE_DATE } }),
    ];
    const wrapper = await mountView(events);

    await wrapper.findAll(".chip").find((c) => c.text().startsWith("On track"))!.trigger("click");
    await wrapper.findAll(".chip").find((c) => c.text().startsWith("All"))!.trigger("click");

    expect(wrapper.findAll(".group-header")).toHaveLength(2);
    expect(rowTitles(wrapper)).toEqual(["Plan Event", "Confirmed Event"]);
  });
});

describe("CoordinatorWorkloadView — dead requests sort into Past even before their date", () => {
  it("puts a Rejected event in Past although its event date is still in the future", async () => {
    const wrapper = await mountView([
      makeEvent({ status: "Rejected", submitted_details: { name: "Rejected Event", proposedDate: FUTURE_DATE } }),
    ]);

    expect(wrapper.find(".tab--active").text()).toContain("Upcoming");
    expect(rowTitles(wrapper)).toHaveLength(0);

    await clickTab(wrapper, "Past");
    expect(rowTitles(wrapper)).toEqual(["Rejected Event"]);
  });

  it("puts a Cancelled event in Past although its event date is still in the future", async () => {
    const wrapper = await mountView([
      makeEvent({ status: "Cancelled", submitted_details: { name: "Cancelled Event", proposedDate: FUTURE_DATE } }),
    ]);

    await clickTab(wrapper, "Past");
    expect(rowTitles(wrapper)).toEqual(["Cancelled Event"]);
  });

  it("does not apply this to the All events page — a future-dated Rejected event stays Upcoming there", async () => {
    const wrapper = await mountView(
      [makeEvent({ status: "Rejected", submitted_details: { name: "Rejected Event", proposedDate: FUTURE_DATE } })],
      "COORD-0001",
      "all",
    );

    expect(wrapper.find(".tab--active").text()).toContain("Upcoming");
    expect(rowTitles(wrapper)).toEqual(["Rejected Event"]);
  });
});

describe("CoordinatorWorkloadView — To Complete tab (Confirmed events that have ended)", () => {
  const ended = (id: number, name: string, overrides: Partial<EventSummary> = {}) =>
    makeEvent({ id, status: "Confirmed", submitted_details: { name, proposedDate: PAST_DATE }, ...overrides });

  it.each(["mine", "all"] as const)("on %s: a Confirmed event whose date has passed is under To Complete, not Past", async (scope) => {
    const wrapper = await mountView(
      [
        makeEvent({ id: 1, status: "Confirmed", submitted_details: { name: "Future Event", proposedDate: FUTURE_DATE } }),
        ended(2, "Ended Event"),
        makeEvent({ id: 3, status: "Completed", submitted_details: { name: "Done Event", proposedDate: PAST_DATE } }),
      ],
      "COORD-0001",
      scope,
    );

    expect(wrapper.findAll("[role='tab']").map((t) => t.text().replace(/\s+/g, " "))).toEqual([
      "Upcoming 1",
      "To Complete 1",
      "Past 1",
    ]);
    expect(rowTitles(wrapper)).toEqual(["Future Event"]);

    await clickTab(wrapper, "To Complete");
    expect(wrapper.find(".tab--active").text()).toContain("To Complete");
    expect(rowTitles(wrapper)).toEqual(["Ended Event"]);

    await clickTab(wrapper, "Past");
    expect(rowTitles(wrapper)).toEqual(["Done Event"]);
  });

  it.each(["mine", "all"] as const)("on %s: only Confirmed events go there — other past statuses stay in Past", async (scope) => {
    const wrapper = await mountView(
      [
        makeEvent({ id: 1, status: "Planning", submitted_details: { name: "Planning Event", proposedDate: PAST_DATE } }),
        makeEvent({ id: 2, status: "Rejected", submitted_details: { name: "Rejected Event", proposedDate: PAST_DATE } }),
        makeEvent({ id: 3, status: "Needs Review", submitted_details: { name: "Review Event", proposedDate: PAST_DATE } }),
      ],
      "COORD-0001",
      scope,
    );

    await clickTab(wrapper, "To Complete");
    expect(rowTitles(wrapper)).toHaveLength(0);
    await clickTab(wrapper, "Past");
    expect(rowTitles(wrapper)).toHaveLength(3);
  });

  it("lists the most overdue first", async () => {
    const wrapper = await mountView([
      ended(1, "Recent", { submitted_details: { name: "Recent", proposedDate: "2024-05-01" } }),
      ended(2, "Oldest", { submitted_details: { name: "Oldest", proposedDate: "2001-01-01" } }),
      ended(3, "Middle", { submitted_details: { name: "Middle", proposedDate: "2015-03-01" } }),
    ]);

    await clickTab(wrapper, "To Complete");
    expect(rowTitles(wrapper)).toEqual(["Oldest", "Middle", "Recent"]);
  });

  it("shows a hint worded for the page, only on that tab", async () => {
    const mine = await mountView([ended(1, "Ended Event")]);
    expect(mine.find("[data-testid='complete-hint']").exists()).toBe(false);
    await clickTab(mine, "To Complete");
    expect(mine.get("[data-testid='complete-hint']").text()).toBe(
      "Confirmed events whose date has passed. Open one to mark it completed.",
    );
    await clickTab(mine, "Past");
    expect(mine.find("[data-testid='complete-hint']").exists()).toBe(false);

    const all = await mountView([ended(1, "Ended Event")], "COORD-0001", "all");
    await clickTab(all, "To Complete");
    expect(all.get("[data-testid='complete-hint']").text()).toBe(
      "Confirmed events whose date has passed, waiting for their coordinator to mark them completed.",
    );
  });

  it("says so when nothing is waiting to be completed", async () => {
    const wrapper = await mountView([
      makeEvent({ status: "Confirmed", submitted_details: { name: "Future Event", proposedDate: FUTURE_DATE } }),
    ]);

    await clickTab(wrapper, "To Complete");
    expect(wrapper.text()).toContain("Nothing is waiting to be completed.");
  });

  it("only counts the coordinator's own events on My events, but every event on All events", async () => {
    const events = [ended(1, "Mine"), ended(2, "Someone else's", { coordinator_id: "COORD-0002" })];

    const mine = await mountView(events);
    expect(mine.findAll("[role='tab']")[1].text()).toContain("1");
    const all = await mountView(events, "COORD-0001", "all");
    expect(all.findAll("[role='tab']")[1].text()).toContain("2");
  });
});

describe("CoordinatorWorkloadView — what it asks the server for", () => {
  it("asks for only the coordinator's own events on My events", async () => {
    await mountView([makeEvent()], "COORD-0001", "mine");

    expect(eventsApi.fetchMyEvents).toHaveBeenCalledWith({ assignedToMe: true });
  });

  it("asks for every event on All events", async () => {
    await mountView([makeEvent()], "COORD-0001", "all");

    expect(eventsApi.fetchMyEvents).toHaveBeenCalledWith({ assignedToMe: false });
  });
});

describe.each([["mine"], ["all"]] as const)("CoordinatorWorkloadView — pagination (%s)", (scope) => {
  const many = (count: number, overrides: Partial<EventSummary> = {}) =>
    Array.from({ length: count }, (_, i) =>
      makeEvent({
        id: i + 1,
        status: "Planning",
        submitted_details: { name: `Event ${String(i + 1).padStart(2, "0")}`, proposedDate: FUTURE_DATE },
        ...overrides,
      }),
    );
  const summary = (w: Awaited<ReturnType<typeof mountView>>) =>
    w.find("[data-testid='pagination-summary']").text();
  const goTo = (w: Awaited<ReturnType<typeof mountView>>, page: number) =>
    w.get(`[aria-label='Page ${page}']`).trigger("click");

  it("shows 20 rows a page: 20, then 20, then 5 of 45", async () => {
    const wrapper = await mountView(many(45), "COORD-0001", scope);

    expect(rowTitles(wrapper)).toHaveLength(20);
    expect(summary(wrapper)).toBe("Showing 1–20 of 45");

    await goTo(wrapper, 2);
    expect(rowTitles(wrapper)).toHaveLength(20);
    expect(summary(wrapper)).toBe("Showing 21–40 of 45");

    await goTo(wrapper, 3);
    expect(rowTitles(wrapper)).toHaveLength(5);
    expect(summary(wrapper)).toBe("Showing 41–45 of 45");
  });

  it("shows no pagination bar at 20 events or fewer", async () => {
    const wrapper = await mountView(many(20), "COORD-0001", scope);

    expect(rowTitles(wrapper)).toHaveLength(20);
    expect(wrapper.find("nav[aria-label='Pagination']").exists()).toBe(false);
  });

  it("returns to page 1 when the tab changes", async () => {
    const wrapper = await mountView(
      [...many(45), makeEvent({ id: 100, status: "Planning", submitted_details: { name: "Old", proposedDate: PAST_DATE } })],
      "COORD-0001",
      scope,
    );
    await goTo(wrapper, 3);

    await clickTab(wrapper, "Past");
    await clickTab(wrapper, "Upcoming");

    expect(summary(wrapper)).toBe("Showing 1–20 of 45");
  });

  it("returns to page 1 when the status filter changes", async () => {
    const events = [...many(45), ...many(3).map((e, i) => ({ ...e, id: 200 + i, status: "Requested" as const }))];
    const wrapper = await mountView(events, "COORD-0001", scope);
    await goTo(wrapper, 3);

    await selectStatus(wrapper, "Planning");

    expect(summary(wrapper)).toBe("Showing 1–20 of 45");
  });

  it("keeps the tab counts for the whole list, not the page", async () => {
    const wrapper = await mountView(many(45), "COORD-0001", scope);

    const upcoming = wrapper.findAll("[role='tab']").find((t) => t.text().startsWith("Upcoming"))!;
    expect(upcoming.text()).toContain("45");
  });

  it("repeats a split group's header on the next page with the group's full count", async () => {
    const wrapper = await mountView(many(45), "COORD-0001", scope);

    expect(wrapper.findAll(".group-header__badge").map((b) => b.text())).toEqual(["45"]);
    await goTo(wrapper, 2);
    expect(wrapper.findAll(".group-header__badge").map((b) => b.text())).toEqual(["45"]);
  });
});

describe("CoordinatorWorkloadView — My events page", () => {
  it("defaults to My events", async () => {
    const wrapper = await mountView([]);

    expect(wrapper.find(".h2").text()).toBe("My events");
  });

  it("only lists events assigned to the signed-in coordinator", async () => {
    const wrapper = await mountView([
      makeEvent({ id: 1, coordinator_id: "COORD-0001" }),
      makeEvent({ id: 2, coordinator_id: "COORD-0002" }),
    ]);

    expect(rowTitles(wrapper)).toHaveLength(1);
  });
});
