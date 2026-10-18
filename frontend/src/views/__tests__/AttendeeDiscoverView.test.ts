import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import AttendeeDiscoverView from "../AttendeeDiscoverView.vue";
import { fetchOpenEvents, type OpenEvent } from "../../lib/registrationApi";

vi.mock("../../lib/registrationApi", () => ({ fetchOpenEvents: vi.fn() }));

const mockedOpen = vi.mocked(fetchOpenEvents);

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { render: () => h("div") } },
    { path: "/attendee/events/:id", name: "attendee-event-detail", component: { render: () => h("div") } },
  ],
});

function openEvent(overrides: Partial<OpenEvent> = {}): OpenEvent {
  return {
    id: 1,
    name: "Career Networking Night",
    description: "Talk to employers and alumni.",
    proposedDate: "2026-11-19",
    startTime: "18:30",
    endTime: "21:00",
    accessibility: null,
    organiserName: "Pat Organiser",
    capacity: null,
    slotsLeft: null,
    registrationStatus: null,
    ...overrides,
  };
}

async function mountView() {
  const wrapper = mount(AttendeeDiscoverView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AttendeeDiscoverView", () => {
  it("lists open events soonest first, with a count", async () => {
    mockedOpen.mockResolvedValue([
      openEvent({ id: 2, name: "Later", proposedDate: "2026-12-04" }),
      openEvent({ id: 1, name: "Sooner", proposedDate: "2026-11-19" }),
    ]);
    const wrapper = await mountView();

    expect(wrapper.findAll(".card-title").map((t) => t.text())).toEqual(["Sooner", "Later"]);
    expect(wrapper.text()).toContain("Showing 2 events");
  });

  it("follows the organiser's card: description, date and time on separate lines, and the organiser's name", async () => {
    mockedOpen.mockResolvedValue([openEvent(), openEvent({ id: 2, name: "No Organiser", organiserName: null, proposedDate: "2026-12-04" })]);
    const wrapper = await mountView();

    const [first, second] = wrapper.findAll(".event-card");
    expect(first.find(".card-description").text()).toBe("Talk to employers and alumni.");
    expect(first.find(".card-person").text()).toContain("Organiser: Pat Organiser");
    expect(first.text()).not.toContain("Coordinator");
    expect(first.findAll(".fact").map((fact) => fact.text())).toEqual(["19 Nov 2026", "6:30 PM to 9:00 PM"]);
    expect(first.find(".badge__dot").exists()).toBe(true);
    expect(second.find(".card-person").exists()).toBe(false);
  });

  it("makes the whole card a link to the event, never a Register button", async () => {
    mockedOpen.mockResolvedValue([openEvent()]);
    const wrapper = await mountView();

    expect(wrapper.text()).not.toContain("Register");
    expect(wrapper.text()).not.toContain("View details");
    expect(wrapper.find("[role='img']").exists()).toBe(false);
    const card = wrapper.find("a.event-card");
    expect(card.attributes("href")).toBe("/attendee/events/1");
  });

  it("shows slots left on each capped card, Full at zero, and nothing for an uncapped event", async () => {
    mockedOpen.mockResolvedValue([
      openEvent({ id: 1, capacity: 50, slotsLeft: 12, proposedDate: "2026-11-01" }),
      openEvent({ id: 2, capacity: 10, slotsLeft: 1, proposedDate: "2026-11-02" }),
      openEvent({ id: 3, capacity: 10, slotsLeft: 0, proposedDate: "2026-11-03" }),
      openEvent({ id: 4, proposedDate: "2026-11-04" }),
    ]);
    const wrapper = await mountView();

    const slots = wrapper.findAll("[data-testid='slots-left']");
    expect(slots.map((s) => s.text())).toEqual(["12 slots left", "1 slot left", "Full"]);
    expect(slots[2].classes()).toContain("card-aside--alert");
    expect(wrapper.findAll(".event-card")[3].find("[data-testid='slots-left']").exists()).toBe(false);
  });

  it("badges an unregistered event Open and a registered one Registered", async () => {
    mockedOpen.mockResolvedValue([
      openEvent({ id: 1, registrationStatus: null }),
      openEvent({ id: 2, registrationStatus: "Registered", proposedDate: "2026-12-01" }),
    ]);
    const wrapper = await mountView();

    const badges = wrapper.findAll(".badge");
    expect(badges[0].text()).toBe("Open");
    expect(badges[1].text()).toBe("Registered");
    expect(badges[1].classes()).toContain("status-success");
  });

  it("shows an empty message when nothing is open", async () => {
    mockedOpen.mockResolvedValue([]);
    const wrapper = await mountView();

    expect(wrapper.text()).toContain("No events are open for registration right now");
  });

  it("shows an error when loading fails", async () => {
    mockedOpen.mockRejectedValue(new Error("boom"));
    const wrapper = await mountView();

    expect(wrapper.find("[role='alert']").text()).toContain("couldn't load events");
  });
});
