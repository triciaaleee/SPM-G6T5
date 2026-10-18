import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import LeadEventList from "../LeadEventList.vue";
import type { EventSummary } from "../../lib/eventsApi";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { render: () => h("div") } },
    { path: "/events/:id", name: "event-detail", component: { render: () => h("div") } },
  ],
});

function makeEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: 3,
    status: "Planning",
    submitted_details: { name: "Matcha Making", proposedDate: "2099-10-16", venue: "parking" },
    coordinator_id: "COORD-0001",
    coordinator: { name: "Jonas" },
    organiser: null,
    review_outcome: null,
    decided_at: null,
    decided_by: null,
    created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

const mountList = (events: EventSummary[]) => mount(LeadEventList, { props: { events }, global: { plugins: [router] } });

describe("LeadEventList", () => {
  it("is a plain list of clickable rows, with no table header", () => {
    const wrapper = mountList([makeEvent(), makeEvent({ id: 4 })]);

    expect(wrapper.findAll("li")).toHaveLength(2);
    expect(wrapper.find(".row--header").exists()).toBe(false);
    expect(wrapper.find("a.row").attributes("href")).toBe("/events/3");
  });

  it("shows the name, a date and venue line, and the status badge", () => {
    const row = mountList([makeEvent()]).find(".row");

    expect(row.find(".cell-event__name").text()).toBe("Matcha Making");
    expect(row.find(".row__details").text()).toContain("parking");
    expect(row.find(".badge").text()).toBe("Planning");
  });

  it("says Not set when the venue is missing and shows Awaiting Clarification for that status", () => {
    const row = mountList([
      makeEvent({ status: "Clarification Requested", submitted_details: { name: "X", proposedDate: "2099-10-16" } }),
    ]).find(".row");

    expect(row.find(".row__details").text()).toContain("Not set");
    expect(row.find(".badge").text()).toBe("Awaiting Clarification");
  });
});
