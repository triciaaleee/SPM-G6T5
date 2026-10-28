import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import EventsListView from "../EventsListView.vue";
import { deleteDraft, fetchMyEvents, getCurrentUser, type EventSummary } from "../../lib/eventsApi";

vi.mock("../../lib/eventsApi", () => ({
  fetchMyEvents: vi.fn(),
  getCurrentUser: vi.fn(),
  deleteDraft: vi.fn(),
}));

const mockedList = vi.mocked(fetchMyEvents);
const mockedUser = vi.mocked(getCurrentUser);
const mockedDelete = vi.mocked(deleteDraft);

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { render: () => h("div") } },
    { path: "/events/:id", name: "event-detail", component: { render: () => h("div") } },
    { path: "/events/:id/edit", name: "edit-draft", component: { render: () => h("div") } },
    { path: "/events/new", name: "new-event-request", component: { render: () => h("div") } },
    { path: "/venues", name: "venue-search", component: { render: () => h("div") } },
  ],
});

function makeEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: 1,
    status: "Requested",
    submitted_details: {
      name: "Alumni Gala",
      proposedDate: "2099-06-15",
      startTime: "18:00",
      endTime: "21:00",
      registrationNeeded: true,
    },
    coordinator_id: "COORD-0001",
    coordinator: { name: "Alice Coord" },
    organiser: { name: "Pat Organiser" },
    review_outcome: null,
    decided_at: null,
    decided_by: null,
    created_at: "2026-10-12T00:00:00Z",
    ...overrides,
  };
}

async function mountView(events: EventSummary[], role = "organiser") {
  mockedList.mockResolvedValue(events);
  mockedUser.mockResolvedValue({ id: "ORG-0001", role });
  const wrapper = mount(EventsListView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("EventsListView", () => {
  it("shows each submitted event as an EventCard linking to the event", async () => {
    const wrapper = await mountView([makeEvent()]);

    const card = wrapper.find("a.event-card");
    expect(card.attributes("href")).toBe("/events/1");
    expect(card.find(".card-title").text()).toBe("Alumni Gala");
    expect(card.find(".badge").text()).toBe("Requested");
    expect(card.find(".badge__dot").exists()).toBe(true);
    expect(card.findAll(".badge").map((b) => b.text())).toContain("Registration Required");
  });

  it("puts the date and the time on separate lines, the time with a clock icon", async () => {
    const wrapper = await mountView([makeEvent()]);

    const facts = wrapper.findAll(".event-card .fact");
    expect(facts.map((fact) => fact.text())).toEqual(["15 Jun 2099", "6:00 PM to 9:00 PM"]);
    expect(facts[1].find("svg").exists()).toBe(true);
  });

  it("names the coordinator, or says Unassigned, and shows when it was submitted", async () => {
    const wrapper = await mountView([
      makeEvent(),
      makeEvent({ id: 2, status: "Unassigned", coordinator_id: null, coordinator: null }),
    ]);

    const [assigned, unassigned] = wrapper.findAll(".event-card");
    expect(assigned.find(".card-person").text()).toContain("Coordinator: Alice Coord");
    expect(unassigned.find(".card-person").text()).toBe("Coordinator: Unassigned");
    expect(assigned.find(".card-footer__meta").text()).toBe("Submitted: 12/10/2026");
  });

  it("flags an event awaiting the organiser's reply, and shows Clarification Requested as Awaiting Clarification", async () => {
    const wrapper = await mountView([makeEvent({ status: "Clarification Requested" })]);

    expect(wrapper.find(".reply-action").text()).toBe("Reply Needed");
    expect(wrapper.find(".badge").text()).toBe("Awaiting Clarification");
  });

  it("does not ask a coordinator to reply", async () => {
    const wrapper = await mountView([makeEvent({ status: "Clarification Requested" })], "coordinator");

    expect(wrapper.find(".reply-action").exists()).toBe(false);
  });

  describe("drafts", () => {
    const draft = () => makeEvent({ id: 5, status: "Draft", coordinator: null, coordinator_id: null });

    it("lists drafts under the Drafts tab, linking to the draft editor, with a Delete action", async () => {
      const wrapper = await mountView([makeEvent(), draft()]);
      expect(wrapper.findAll(".event-card")).toHaveLength(1);

      await wrapper.findAll("[role='tab']")[1].trigger("click");

      expect(wrapper.findAll(".event-card")).toHaveLength(1);
      expect(wrapper.find("a.event-card").attributes("href")).toBe("/events/5/edit");
      expect(wrapper.find(".delete-draft-action").text()).toBe("Delete");
    });

    it("asks for confirmation before deleting, and removes the draft once confirmed", async () => {
      mockedDelete.mockResolvedValue(undefined);
      const wrapper = await mountView([draft()]);
      await wrapper.findAll("[role='tab']")[1].trigger("click");

      await wrapper.find(".delete-draft-action").trigger("click");
      expect(wrapper.find("[role='alertdialog']").exists()).toBe(true);
      expect(mockedDelete).not.toHaveBeenCalled();

      await wrapper.find(".btn--danger-solid").trigger("click");
      await flushPromises();

      expect(mockedDelete).toHaveBeenCalledWith(5);
      expect(wrapper.find(".event-card").exists()).toBe(false);
    });

    it("keeps the draft when the dialog is cancelled", async () => {
      const wrapper = await mountView([draft()]);
      await wrapper.findAll("[role='tab']")[1].trigger("click");

      await wrapper.find(".delete-draft-action").trigger("click");
      await wrapper.find(".modal-actions .btn--outline").trigger("click");

      expect(wrapper.find("[role='alertdialog']").exists()).toBe(false);
      expect(mockedDelete).not.toHaveBeenCalled();
      expect(wrapper.find(".event-card").exists()).toBe(true);
    });
  });

  it("offers the organiser New event request, and the coordinator Find venues, as primary buttons", async () => {
    const organiser = await mountView([makeEvent()]);
    expect(organiser.find("a.btn--primary").text()).toBe("New event request");

    const coordinator = await mountView([makeEvent()], "coordinator");
    expect(coordinator.find("a.btn--primary").text()).toBe("Find venues");
  });

  it("shows empty and error states", async () => {
    const empty = await mountView([]);
    expect(empty.text()).toContain("You haven't submitted any events yet.");

    mockedList.mockRejectedValue(new Error("boom"));
    const failed = mount(EventsListView, { global: { plugins: [router] } });
    await flushPromises();
    expect(failed.text()).toContain("couldn't load your events");
  });
});
