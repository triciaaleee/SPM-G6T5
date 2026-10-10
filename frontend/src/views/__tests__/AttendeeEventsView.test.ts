import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import AttendeeEventsView from "../AttendeeEventsView.vue";
import { fetchMyRegistrations, type MyRegistration } from "../../lib/registrationApi";

vi.mock("../../lib/registrationApi", () => ({ fetchMyRegistrations: vi.fn() }));
vi.mock("../../lib/auth", () => ({
  getStoredUser: () => ({ id: "ATT-0001", name: "Attendee One", email: "a@example.com", role: "attendee" }),
}));

const mockedFetch = vi.mocked(fetchMyRegistrations);

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/attendee/events", name: "attendee-events", component: { render: () => h("div") } },
    { path: "/attendee/events/:id", name: "attendee-event-detail", component: { render: () => h("div") } },
  ],
});

function registration(
  id: number,
  overrides: Partial<MyRegistration> = {},
  event: Record<string, unknown> = {},
): MyRegistration {
  return {
    registrationId: id,
    eventId: id,
    userId: "ATT-0001",
    status: "Registered",
    createdAt: "2026-01-01T00:00:00Z",
    additionalInfo: null,
    event: {
      name: `Event ${id}`,
      description: `About event ${id}`,
      proposedDate: "2099-01-01",
      startTime: "10:00",
      endTime: "16:00",
      venues: ["Great Lawn"],
      accessibility: "Step-free entry and a hearing loop.",
      ...event,
    },
    ...overrides,
  };
}

async function mountView() {
  const wrapper = mount(AttendeeEventsView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AttendeeEventsView", () => {
  it("loads the signed-in attendee's registrations", async () => {
    mockedFetch.mockResolvedValue([]);
    await mountView();

    expect(mockedFetch).toHaveBeenCalledWith("ATT-0001");
  });

  it("splits events into Upcoming and Past, with no count badges on the tabs", async () => {
    mockedFetch.mockResolvedValue([
      registration(1),
      registration(2),
      registration(3, {}, { proposedDate: "2000-01-01" }),
    ]);
    const wrapper = await mountView();

    const tabs = wrapper.findAll('[role="tab"]');
    expect(tabs.map((t) => t.text())).toEqual(["Upcoming", "Past", "Withdrawn"]);
    expect(wrapper.findAll("article")).toHaveLength(2);

    await tabs[1].trigger("click");

    expect(wrapper.findAll("article")).toHaveLength(1);
    expect(wrapper.find("article").text()).toContain("Event 3");
  });

  it("shows the event's name, description, date, time and venue on the card", async () => {
    mockedFetch.mockResolvedValue([registration(1)]);
    const wrapper = await mountView();

    const text = wrapper.find("article").text();
    expect(text).toContain("Registered");
    expect(text).toContain("Event 1");
    expect(text).toContain("About event 1");
    expect(text).toContain("1 Jan 2099");
    expect(text).toContain("10:00 AM to 4:00 PM");
    expect(text).toContain("Great Lawn");
  });

  it("marks past events with a grey Event over badge", async () => {
    mockedFetch.mockResolvedValue([registration(1), registration(2, {}, { proposedDate: "2000-01-01" })]);
    const wrapper = await mountView();

    expect(wrapper.find(".badge").text()).toBe("Registered");
    expect(wrapper.find(".status-over").exists()).toBe(false);

    await wrapper.findAll('[role="tab"]')[1].trigger("click");

    const badge = wrapper.find(".badge");
    expect(badge.text()).toBe("Event over");
    expect(badge.classes()).toContain("status-over");
  });

  it("puts withdrawn registrations only under Withdrawn, past or not", async () => {
    mockedFetch.mockResolvedValue([
      registration(1),
      registration(2, { status: "Withdrawn" }),
      registration(3, { status: "Withdrawn" }, { proposedDate: "2000-01-01" }),
    ]);
    const wrapper = await mountView();
    const tabs = wrapper.findAll('[role="tab"]');

    expect(wrapper.findAll("article h2").map((h) => h.text())).toEqual(["Event 1"]);

    await tabs[1].trigger("click");
    expect(wrapper.findAll("article")).toHaveLength(0);

    await tabs[2].trigger("click");
    expect(wrapper.findAll("article h2").map((h) => h.text())).toEqual(["Event 2", "Event 3"]);
    expect(wrapper.findAll(".badge").map((b) => b.text())).toEqual(["Withdrawn", "Withdrawn"]);
    expect(wrapper.find(".status-over").exists()).toBe(false);
  });

  it("has no Withdraw button and no dot in the status badge", async () => {
    mockedFetch.mockResolvedValue([registration(1), registration(2, { status: "Withdrawn" })]);
    const wrapper = await mountView();

    // The Withdrawn tab is a tab, not a card action: no button inside any card.
    expect(wrapper.findAll("article button")).toHaveLength(0);
    for (const tab of wrapper.findAll('[role="tab"]')) {
      await tab.trigger("click");
      for (const badge of wrapper.findAll(".badge")) expect(badge.element.children).toHaveLength(0);
      expect(wrapper.findAll("article button")).toHaveLength(0);
    }
  });

  it("shows the accessibility note on the card, and nothing when there is none", async () => {
    mockedFetch.mockResolvedValue([registration(1), registration(2, {}, { accessibility: null })]);
    const wrapper = await mountView();

    const cards = wrapper.findAll("article");
    expect(cards[0].find(".fact--accessibility").text()).toBe("Step-free entry and a hearing loop.");
    expect(cards[1].find(".fact--accessibility").exists()).toBe(false);
  });

  it("lists upcoming events soonest first", async () => {
    mockedFetch.mockResolvedValue([
      registration(1, {}, { proposedDate: "2099-06-01" }),
      registration(2, {}, { proposedDate: "2099-01-01" }),
    ]);
    const wrapper = await mountView();

    expect(wrapper.findAll("article h2").map((h) => h.text())).toEqual(["Event 2", "Event 1"]);
  });

  it("falls back when the venue or event info is missing", async () => {
    mockedFetch.mockResolvedValue([registration(1, {}, { venues: [] }), registration(2, { event: null })]);
    const wrapper = await mountView();

    const cards = wrapper.findAll("article");
    expect(cards[0].text()).toContain("Venue to be confirmed");
    expect(cards[1].text()).toContain("Event #2");
  });

  it("links each card to its event", async () => {
    mockedFetch.mockResolvedValue([registration(7)]);
    const wrapper = await mountView();

    expect(wrapper.find("article a").attributes("href")).toBe("/attendee/events/7");
  });

  it("shows an empty state for a tab with no events", async () => {
    mockedFetch.mockResolvedValue([]);
    const wrapper = await mountView();

    expect(wrapper.text()).toContain("You have no upcoming events.");
    await wrapper.findAll('[role="tab"]')[1].trigger("click");
    expect(wrapper.text()).toContain("You have no past events.");
    await wrapper.findAll('[role="tab"]')[2].trigger("click");
    expect(wrapper.text()).toContain("You haven't withdrawn from any events.");
  });

  it("shows an error message when loading fails", async () => {
    mockedFetch.mockRejectedValue(new Error("boom"));
    const wrapper = await mountView();

    expect(wrapper.find('[role="alert"]').text()).toContain("couldn't load your events");
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(0);
  });
});
