import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import LeadEventTable from "../LeadEventTable.vue";
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

const mountTable = (events: EventSummary[], compact = false) =>
  mount(LeadEventTable, { props: { events, compact }, global: { plugins: [router] } });

describe("LeadEventTable", () => {
  it("is a table with column headings and a link per row", () => {
    const wrapper = mountTable([makeEvent(), makeEvent({ id: 4 })]);

    expect(wrapper.find(".row--header").exists()).toBe(true);
    expect(wrapper.findAll("a.row")).toHaveLength(2);
    expect(wrapper.find("a.row").attributes("href")).toBe("/events/3");
  });

  describe("compact (the Lead dashboard cards)", () => {
    it("is a plain list of clickable rows, with no column headings", () => {
      const wrapper = mountTable([makeEvent(), makeEvent({ id: 4 })], true);

      expect(wrapper.find(".row--header").exists()).toBe(false);
      expect(wrapper.findAll("a.row")).toHaveLength(2);
      expect(wrapper.find("a.row").attributes("href")).toBe("/events/3");
    });

    it("shows the name, a date and venue line, and the status badge", () => {
      const row = mountTable([makeEvent()], true).find(".row");

      expect(row.find(".cell-event__name").text()).toBe("Matcha Making");
      expect(row.find(".row__details").text()).toContain("parking");
      expect(row.find(".badge").text()).toBe("Planning");
    });

    it("says Not set when the venue is missing and shows Clarification Requested for that status", () => {
      const row = mountTable(
        [makeEvent({ status: "Clarification Requested", submitted_details: { name: "X", proposedDate: "2099-10-16" } })],
        true,
      ).find(".row");

      expect(row.find(".row__details").text()).toContain("Not set");
      expect(row.find(".badge").text()).toBe("Clarification Requested");
    });
  });
});
