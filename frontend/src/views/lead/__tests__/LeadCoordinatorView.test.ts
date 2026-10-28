import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import LeadCoordinatorView from "../LeadCoordinatorView.vue";
import * as eventsApi from "../../../lib/eventsApi";
import * as usersApi from "../../../lib/usersApi";

vi.mock("../../../lib/eventsApi", () => ({ fetchMyEvents: vi.fn() }));
vi.mock("../../../lib/usersApi", () => ({ fetchCoordinators: vi.fn() }));

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

describe("LeadCoordinatorView — subheaders, chips and pagination", () => {
  type Wrapper = Awaited<ReturnType<typeof mountView>>;
  const mixed = () => [
    makeEvent(1, { status: "Confirmed" }),
    makeEvent(2, { status: "Planning" }),
    makeEvent(3, { status: "Safety Review" }),
    makeEvent(4, { status: "Requested" }),
    makeEvent(5, { status: "Clarification Requested" }),
  ];
  const squash = (text: string) => text.replace(/\s+/g, " ");
  const headers = (w: Wrapper) =>
    w.findAll(".group-header").map((h) => `${h.find(".group-header__title").text()} ${h.find(".group-header__badge").text()}`);
  const names = (w: Wrapper) => w.findAll(".cell-event__name").map((n) => n.text());
  const chip = (w: Wrapper, label: string) => w.findAll(".chip").find((c) => c.text().startsWith(label))!;
  const summary = (w: Wrapper) => w.find("[data-testid='pagination-summary']").text();
  /** n Planning events on distinct dates (2099-01-01 onwards). */
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      makeEvent(i + 1, {
        submitted_details: {
          name: `Event ${i + 1}`,
          proposedDate: `2099-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
        },
      }),
    );

  it("groups the rows by who acts next, each with its full count", async () => {
    const wrapper = await mountView("COORD-0001", mixed());

    expect(headers(wrapper)).toEqual(["Needs coordinator action 2", "Waiting on others 2", "On track 1"]);
    expect(names(wrapper)).toEqual(["Event 2", "Event 4", "Event 3", "Event 5", "Event 1"]);
  });

  it("offers a chip per group with the whole list's counts, and none for an empty group", async () => {
    const wrapper = await mountView("COORD-0001", [makeEvent(1, { status: "Planning" }), makeEvent(2, { status: "Requested" })]);

    expect(wrapper.findAll(".chip").map((c) => squash(c.text()))).toEqual(["All 2", "Needs coordinator action 2"]);
  });

  it("narrows to one group when its chip is chosen, dropping the subheaders", async () => {
    const wrapper = await mountView("COORD-0001", mixed());

    await chip(wrapper, "Waiting on others").trigger("click");

    expect(names(wrapper)).toEqual(["Event 3", "Event 5"]);
    expect(headers(wrapper)).toEqual([]);
    expect(chip(wrapper, "Waiting on others").attributes("aria-pressed")).toBe("true");
    expect(chip(wrapper, "All").text()).toContain("5");
  });

  it("shows 20 rows a page: 20, then 20, then 5 of 45", async () => {
    const wrapper = await mountView("COORD-0001", many(45));

    expect(names(wrapper)).toHaveLength(20);
    expect(summary(wrapper)).toBe("Showing 1–20 of 45");
    await wrapper.get("[aria-label='Page 3']").trigger("click");
    expect(names(wrapper)).toHaveLength(5);
  });

  it("shows no pagination bar at 20 events or fewer", async () => {
    const wrapper = await mountView("COORD-0001", many(20));

    expect(wrapper.find("nav[aria-label='Pagination']").exists()).toBe(false);
  });

  it("repeats a split group's header on the next page with the group's full count", async () => {
    const wrapper = await mountView("COORD-0001", many(45));

    expect(headers(wrapper)).toEqual(["Needs coordinator action 45"]);
    await wrapper.get("[aria-label='Page 2']").trigger("click");
    expect(headers(wrapper)).toEqual(["Needs coordinator action 45"]);
  });

  it("returns to page 1 when a chip is chosen", async () => {
    const events = [...many(45), ...[101, 102].map((id) => makeEvent(id, { status: "Confirmed" }))];
    const wrapper = await mountView("COORD-0001", events);
    await wrapper.get("[aria-label='Page 3']").trigger("click");

    await chip(wrapper, "On track").trigger("click");
    await chip(wrapper, "All").trigger("click");

    expect(summary(wrapper)).toBe("Showing 1–20 of 47");
  });
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
