import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import LandingView from "../LandingView.vue";
import PublicEventsView from "../PublicEventsView.vue";
import PublicVenuesView from "../PublicVenuesView.vue";
import {
  fetchPublicEventVenues,
  fetchPublicEvents,
  fetchPublicVenues,
  type PublicEvent,
  type PublicVenue,
} from "../../../lib/publicApi";

vi.mock("../../../lib/publicApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/publicApi")>("../../../lib/publicApi");
  return {
    byStartTime: actual.byStartTime,
    fetchPublicEvents: vi.fn(),
    fetchPublicEventVenues: vi.fn(),
    fetchPublicVenues: vi.fn(),
  };
});

const mockedEvents = vi.mocked(fetchPublicEvents);
const mockedEventVenues = vi.mocked(fetchPublicEventVenues);
const mockedVenues = vi.mocked(fetchPublicVenues);

const stub = { render: () => h("div") };
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", name: "welcome", component: stub },
    { path: "/login", name: "login", component: stub },
    { path: "/signup", name: "signup", component: stub },
    { path: "/explore/events", name: "public-events", component: stub },
    { path: "/explore/events/:id", name: "public-event-detail", component: stub },
    { path: "/explore/venues", name: "public-venues", component: stub },
  ],
});

function event(id: number, overrides: Partial<PublicEvent> = {}): PublicEvent {
  return {
    id,
    name: `Event ${id}`,
    description: null,
    proposedDate: `2099-01-0${id}`,
    startTime: "10:00",
    endTime: "12:00",
    accessibility: null,
    organiserName: "Pat",
    registrationState: "OPEN",
    open: true,
    ...overrides,
  };
}

function venue(id: number, overrides: Partial<PublicVenue> = {}): PublicVenue {
  return {
    id,
    name: `Venue ${id}`,
    location: "Block A",
    description: null,
    capacity: 100,
    accessibility: [],
    layouts: ["Theatre"],
    facilities: ["Projector"],
    upcomingEvents: [],
    ...overrides,
  };
}

async function mountView(component: object) {
  await router.push("/");
  await router.isReady();
  const wrapper = mount(component, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

const titles = (wrapper: Awaited<ReturnType<typeof mountView>>, selector: string) =>
  wrapper.findAll(selector).map((el) => el.text());

beforeEach(() => {
  vi.clearAllMocks();
  mockedEventVenues.mockResolvedValue(new Map());
  mockedVenues.mockResolvedValue([]);
  mockedEvents.mockResolvedValue([]);
});

describe("LandingView", () => {
  it("previews three events (open ones first) and the three busiest venues", async () => {
    mockedEvents.mockResolvedValue([
      event(1, { registrationState: "CLOSED", open: false }),
      event(2),
      event(3),
      event(4),
    ]);
    mockedVenues.mockResolvedValue([
      venue(1),
      venue(2, { upcomingEvents: [{ id: 2, name: "Event 2", proposedDate: null, startTime: null }] }),
      venue(3, { capacity: 500 }),
      venue(4, { capacity: 50 }),
    ]);
    const wrapper = await mountView(LandingView);

    expect(titles(wrapper, ".card-title")).toEqual(["Event 2", "Event 3", "Event 4"]);
    expect(titles(wrapper, ".venue-card__title")).toEqual(["Venue 2", "Venue 3", "Venue 1"]);
    expect(wrapper.text()).toContain("ConnectSphere");
  });

  it("still shows venues when events fail to load", async () => {
    mockedEvents.mockRejectedValue(new Error("down"));
    mockedVenues.mockResolvedValue([venue(1)]);
    const wrapper = await mountView(LandingView);

    expect(wrapper.text()).toContain("We couldn't load events");
    expect(titles(wrapper, ".venue-card__title")).toEqual(["Venue 1"]);
  });
});

describe("PublicEventsView", () => {
  beforeEach(() => {
    mockedEvents.mockResolvedValue([
      event(3, { name: "Jazz Night" }),
      event(1, { name: "Campus Fair", registrationState: "CLOSED", open: false }),
      event(2, { name: "Film Club" }),
    ]);
    mockedEventVenues.mockResolvedValue(new Map([[2, ["Studio Theatre"]]]));
  });

  it("lists every public event soonest first, with venue names", async () => {
    const wrapper = await mountView(PublicEventsView);

    expect(titles(wrapper, ".card-title")).toEqual(["Campus Fair", "Film Club", "Jazz Night"]);
    expect(wrapper.text()).toContain("Studio Theatre");
    expect(wrapper.text()).toContain("Showing 3 of 3 events");
  });

  it("filters by tab, search (including venue names) and sorts latest first", async () => {
    const wrapper = await mountView(PublicEventsView);

    await wrapper.findAll(".tab")[1].trigger("click");
    expect(titles(wrapper, ".card-title")).toEqual(["Film Club", "Jazz Night"]);

    await wrapper.findAll(".tab")[2].trigger("click");
    expect(titles(wrapper, ".card-title")).toEqual(["Campus Fair"]);

    await wrapper.findAll(".tab")[0].trigger("click");
    await wrapper.find("input[type='search']").setValue("studio");
    expect(titles(wrapper, ".card-title")).toEqual(["Film Club"]);

    await wrapper.find("input[type='search']").setValue("");
    await wrapper.find("select").setValue("latest");
    expect(titles(wrapper, ".card-title")).toEqual(["Jazz Night", "Film Club", "Campus Fair"]);
  });

  it("links each card to the public event page", async () => {
    const wrapper = await mountView(PublicEventsView);

    expect(wrapper.find(".event-card").attributes("href")).toBe("/explore/events/1");
  });
});

describe("PublicVenuesView", () => {
  beforeEach(() => {
    mockedVenues.mockResolvedValue([
      venue(1, { name: "Main Hall", capacity: 300, location: "Block A" }),
      venue(2, {
        name: "Studio",
        capacity: 40,
        location: "Block B",
        upcomingEvents: [{ id: 7, name: "Film Club", proposedDate: "2099-01-02", startTime: "10:00" }],
      }),
    ]);
  });

  it("lists venues with their next public event linked", async () => {
    const wrapper = await mountView(PublicVenuesView);

    expect(titles(wrapper, ".venue-card__title")).toEqual(["Main Hall", "Studio"]);
    const link = wrapper.find(".next-event__link");
    expect(link.text()).toBe("Film Club");
    expect(link.attributes("href")).toBe("/explore/events/7");
  });

  it("filters by hosting tab, location and capacity", async () => {
    const wrapper = await mountView(PublicVenuesView);

    await wrapper.findAll(".tab")[1].trigger("click");
    expect(titles(wrapper, ".venue-card__title")).toEqual(["Studio"]);

    await wrapper.findAll(".tab")[0].trigger("click");
    const [locationSelect, capacitySelect] = wrapper.findAll("select");
    await locationSelect.setValue("Block A");
    expect(titles(wrapper, ".venue-card__title")).toEqual(["Main Hall"]);

    await locationSelect.setValue("");
    await capacitySelect.setValue("100");
    expect(titles(wrapper, ".venue-card__title")).toEqual(["Main Hall"]);
  });
});
