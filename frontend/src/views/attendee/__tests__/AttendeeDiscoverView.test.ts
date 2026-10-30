import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import AttendeeDiscoverView from "../AttendeeDiscoverView.vue";
import { fetchOpenEvents, type OpenEvent } from "../../../lib/registrationApi";

vi.mock("../../../lib/registrationApi", () => ({ fetchOpenEvents: vi.fn() }));

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
    venues: [],
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

  it("follows the organiser's card: description, date, time and venue on separate lines, and the organiser's name", async () => {
    mockedOpen.mockResolvedValue([openEvent(), openEvent({ id: 2, name: "No Organiser", organiserName: null, proposedDate: "2026-12-04" })]);
    const wrapper = await mountView();

    const [first, second] = wrapper.findAll(".event-card");
    expect(first.find(".card-description").text()).toBe("Talk to employers and alumni.");
    expect(first.find(".card-person").text()).toContain("Organiser: Pat Organiser");
    expect(first.text()).not.toContain("Coordinator");
    expect(first.findAll(".fact").map((fact) => fact.text())).toEqual(["19 Nov 2026", "6:30 PM to 9:00 PM", "Venue to be confirmed"]);
    expect(first.find(".badge__dot").exists()).toBe(true);
    expect(second.find(".card-person").exists()).toBe(false);
  });

  it("does not show the accessibility note on the card: it is on the event details page only", async () => {
    mockedOpen.mockResolvedValue([openEvent({ accessibility: "Step-free entry and a hearing loop." })]);
    const wrapper = await mountView();

    expect(wrapper.find(".event-card").text()).not.toContain("Step-free entry");
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

  it("shows an empty message when there is nothing to show", async () => {
    mockedOpen.mockResolvedValue([]);
    const wrapper = await mountView();

    expect(wrapper.text()).toContain("No events to show right now");
  });

  it("shows the booked venue(s) on the card, or 'Venue to be confirmed' when there is none", async () => {
    mockedOpen.mockResolvedValue([
      openEvent({ id: 1, name: "Booked", venues: ["Great Lawn", "Hall B"] }),
      openEvent({ id: 2, name: "Unbooked", venues: [], proposedDate: "2026-12-04" }),
    ]);
    const wrapper = await mountView();

    const cards = wrapper.findAll(".card-item");
    expect(cards[0].text()).toContain("Great Lawn, Hall B");
    expect(cards[1].text()).toContain("Venue to be confirmed");
  });

  it("lists an event that needs no registration with a 'No registration needed' badge and no places-left text", async () => {
    mockedOpen.mockResolvedValue([
      openEvent({ id: 5, name: "Open Day", registrationNeeded: false, registrationState: "CLOSED", capacity: null, slotsLeft: null }),
    ]);
    const wrapper = await mountView();

    expect(wrapper.get(".card-title").text()).toBe("Open Day");
    expect(wrapper.get(".badge").text()).toBe("No registration needed");
    expect(wrapper.get(".badge").classes()).toContain("status-neutral");
    expect(wrapper.find("[data-testid='slots-left']").exists()).toBe(false);
  });

  it("shows an error when loading fails", async () => {
    mockedOpen.mockRejectedValue(new Error("boom"));
    const wrapper = await mountView();

    expect(wrapper.find("[role='alert']").text()).toContain("couldn't load events");
  });
});
