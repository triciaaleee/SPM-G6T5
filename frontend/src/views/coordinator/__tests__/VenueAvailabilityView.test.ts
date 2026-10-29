import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import VenueAvailabilityView from "../VenueAvailabilityView.vue";
import * as venuesApi from "../../../lib/venuesApi";

vi.mock("../../../lib/venuesApi", () => ({
  emptyVenueFilters: () => ({}),
  searchVenues: vi.fn(),
  fetchVenueAvailability: vi.fn(),
  fetchVenueBookings: vi.fn(),
}));
vi.mock("../../../lib/unavailabilityApi", () => ({ fetchUnavailability: vi.fn() }));

const venues = [
  { id: 3, name: "Innovation Hub", location: "North Campus", description: null, capacity: 180,
    accessibility: [], layouts: [], facilities: [] },
  { id: 1, name: "Grand Ballroom", location: "Central Campus", description: null, capacity: 400,
    accessibility: [], layouts: [], facilities: [] },
];

// The calendar opens on Week, so the focus date 2026-10-08 loads Mon 5 – Sun 11 October.
const WEEK_FROM = "2026-10-05";
const WEEK_TO = "2026-10-11";

const availability: venuesApi.VenueAvailability = {
  venue: { id: 1, name: "Grand Ballroom", location: "Central Campus", capacity: 400, setupMinutes: 30,
    turnaroundMinutes: 45, openingTime: "08:00", closingTime: "22:00" },
  bookings: [
    { id: 1, status: "Approved", date: "2026-10-10", startTime: "10:00", endTime: "12:00", occupiedStart: "09:30",
      occupiedEnd: "12:45", holdExpiresAt: null, event: { id: 11, name: "Gala Dinner" } },
    { id: 2, status: "On Hold", date: "2026-10-10", startTime: "14:00", endTime: "16:00", occupiedStart: "13:30",
      occupiedEnd: "16:45", holdExpiresAt: "2026-10-09T12:00:00Z", event: { id: 12, name: "Tech Talk" } },
  ],
  unavailability: [
    { id: 5, venueId: 1, startDate: "2026-10-09", endDate: "2026-10-09", allDay: true, startTime: null,
      endTime: null, reason: "Floor resurfacing" },
  ],
  target: null,
  freeSlots: [],
};

async function mountView(path = "/venue-availability?date=2026-10-08") {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: "/venue-availability", name: "venue-availability", component: VenueAvailabilityView }],
  });
  await router.push(path);
  const wrapper = mount(VenueAvailabilityView, { global: { plugins: [router] } });
  await flushPromises();
  return { wrapper, router };
}

const legendLabels = (wrapper: Awaited<ReturnType<typeof mountView>>["wrapper"]) =>
  wrapper.findAll("ul[aria-label='Status'] .legend__item").map((li) => li.text());

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(venuesApi.searchVenues).mockResolvedValue({ venues, relax: [] });
  vi.mocked(venuesApi.fetchVenueAvailability).mockResolvedValue(availability);
});

describe("VenueAvailabilityView", () => {
  it("picks the first venue alphabetically and loads the week on screen", async () => {
    await mountView();
    expect(venuesApi.fetchVenueAvailability).toHaveBeenCalledWith(1, WEEK_FROM, WEEK_TO, null);
  });

  it("opens on the venue in the URL", async () => {
    await mountView("/venue-availability?venue=3&date=2026-10-08");
    expect(vi.mocked(venuesApi.fetchVenueAvailability).mock.calls[0][0]).toBe(3);
  });

  it("never asks the staff endpoints for anything — coordinators only use the availability one", async () => {
    await mountView();
    expect(venuesApi.fetchVenueBookings).not.toHaveBeenCalled();
  });

  it("uses the venue staff's key, limited to the three statuses a coordinator can see", async () => {
    const { wrapper } = await mountView();
    expect(legendLabels(wrapper)).toEqual(["Approved", "On Hold", "Unavailable"]);
  });

  it("draws Approved and On Hold bookings and block-outs on the shared calendar", async () => {
    const { wrapper } = await mountView();

    expect(wrapper.find(".entry--approved").attributes("aria-label")).toBe("Gala Dinner, Approved, 10:00–12:00");
    expect(wrapper.find(".entry--hold").attributes("aria-label")).toBe("Tech Talk, On Hold, 14:00–16:00");
    expect(wrapper.find(".entry--block").attributes("aria-label")).toBe("Floor resurfacing, Unavailable, All day");
  });

  it("offers no way to review a request from here", async () => {
    const { wrapper } = await mountView();

    await wrapper.find(".entry--approved").trigger("click");

    expect(wrapper.find("[role='dialog']").text()).toContain("Gala Dinner");
    expect(wrapper.find("[role='dialog']").text()).not.toContain("Expected attendance");
    expect(wrapper.text()).not.toContain("Review in Requests");
  });

it("shows the venue's details inside the controls card", async () => {
    const { wrapper } = await mountView();
    const summary = wrapper.find(".controls .summary");

    expect(summary.exists()).toBe(true);
    expect(summary.text()).toContain("Grand Ballroom");
    expect(summary.text()).toContain("08:00–22:00 daily");
    expect(summary.text()).toContain("30 min");
  });

  it("AC5: requests free slots for the target and lists them", async () => {
    vi.mocked(venuesApi.fetchVenueAvailability).mockResolvedValue({
      ...availability,
      target: { fromDate: "2026-10-10", toDate: "2026-10-11", startTime: "12:00", endTime: "18:00" },
      freeSlots: [{ date: "2026-10-10", start: "16:45", end: "18:00", eventStart: "17:15", eventEnd: "18:00" }],
    });
    const { wrapper, router } = await mountView();

    await wrapper.find("#target-from").setValue("2026-10-10");
    await wrapper.find("#target-to").setValue("2026-10-11");
    await wrapper.find("#target-start").setValue("12:00");
    await wrapper.find("#target-end").setValue("18:00");
    await wrapper.find("form.target").trigger("submit");
    await flushPromises();

    expect(venuesApi.fetchVenueAvailability).toHaveBeenLastCalledWith(
      1,
      WEEK_FROM,
      WEEK_TO,
      { fromDate: "2026-10-10", toDate: "2026-10-11", startTime: "12:00", endTime: "18:00" },
    );
    expect(wrapper.find(".slot-chip").text()).toContain("16:45–18:00");
    expect(wrapper.find(".slot-chip").text()).toContain("event 17:15–18:00");
    expect(router.currentRoute.value.query).toMatchObject({
      tFrom: "2026-10-10", tTo: "2026-10-11", tStart: "12:00", tEnd: "18:00",
    });
  });

  it("reloads the calendar when a target is set on the day already showing", async () => {
    const { wrapper } = await mountView("/venue-availability?date=2026-10-10");
    const before = vi.mocked(venuesApi.fetchVenueAvailability).mock.calls.length;

    await wrapper.find("#target-from").setValue("2026-10-10");
    await wrapper.find("form.target").trigger("submit");
    await flushPromises();

    expect(vi.mocked(venuesApi.fetchVenueAvailability).mock.calls.length).toBe(before + 1);
  });

  it("AC5: without times, searches each target date's whole operating day", async () => {
    const { wrapper } = await mountView();

    await wrapper.find("#target-from").setValue("2026-10-10");
    await wrapper.find("form.target").trigger("submit");
    await flushPromises();

    expect(venuesApi.fetchVenueAvailability).toHaveBeenLastCalledWith(
      1, WEEK_FROM, WEEK_TO,
      { fromDate: "2026-10-10", toDate: "2026-10-10", startTime: null, endTime: null },
    );
  });

  it("places the action buttons in their own row after the target fields", async () => {
    const { wrapper } = await mountView();
    const actions = wrapper.find(".controls__actions");
    expect(actions.exists()).toBe(true);
    expect(wrapper.find("form.target").find(".btn--primary").exists()).toBe(false);
    expect(actions.find(".btn--primary").attributes()).toMatchObject({ type: "submit", form: "target-form" });
  });

  it("flags an invalid target without calling the API", async () => {
    const { wrapper } = await mountView();
    const calls = vi.mocked(venuesApi.fetchVenueAvailability).mock.calls.length;

    await wrapper.find("#target-from").setValue("2026-10-10");
    await wrapper.find("#target-to").setValue("2026-10-09");
    await wrapper.find("#target-start").setValue("18:00");
    await wrapper.find("#target-end").setValue("09:00");
    await wrapper.find("form.target").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("The end date must not be before the start date.");
    expect(wrapper.text()).toContain("The end time must be after the start time.");
    expect(vi.mocked(venuesApi.fetchVenueAvailability).mock.calls.length).toBe(calls);
  });

  it("says so when availability can't be loaded", async () => {
    vi.mocked(venuesApi.fetchVenueAvailability).mockRejectedValue(new Error("Failed to load venue availability"));
    const { wrapper } = await mountView();
    expect(wrapper.find("[role='alert']").text()).toContain("Grand Ballroom");
  });
});
