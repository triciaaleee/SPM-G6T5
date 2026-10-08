import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import VenueAvailabilityView from "../VenueAvailabilityView.vue";
import * as venuesApi from "../../lib/venuesApi";

vi.mock("../../lib/venuesApi", () => ({
  emptyVenueFilters: () => ({}),
  searchVenues: vi.fn(),
  fetchVenueAvailability: vi.fn(),
}));

const venues = [
  { id: 3, name: "Innovation Hub", location: "North Campus", description: null, capacity: 180,
    accessibility: [], layouts: [], facilities: [] },
  { id: 1, name: "Grand Ballroom", location: "Central Campus", description: null, capacity: 400,
    accessibility: [], layouts: [], facilities: [] },
];

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
    { id: 5, venueId: 1, startDate: "2026-10-12", endDate: "2026-10-12", allDay: true, startTime: null,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(venuesApi.searchVenues).mockResolvedValue({ venues, relax: [] });
  vi.mocked(venuesApi.fetchVenueAvailability).mockResolvedValue(availability);
});

describe("VenueAvailabilityView", () => {
  it("picks the first venue alphabetically and loads the month grid range", async () => {
    await mountView();
    expect(venuesApi.fetchVenueAvailability).toHaveBeenCalledWith(1, "2026-09-28", "2026-11-01", null, expect.anything());
  });

  it("opens on the venue in the URL", async () => {
    await mountView("/venue-availability?venue=3&date=2026-10-08");
    expect(vi.mocked(venuesApi.fetchVenueAvailability).mock.calls[0][0]).toBe(3);
  });

  it("shows Approved and On Hold bookings with distinct treatments, and block-outs", async () => {
    const { wrapper } = await mountView();
    const approved = wrapper.find(".chip--approved");
    const onHold = wrapper.find(".chip--on-hold");
    expect(approved.text()).toContain("09:30–12:45");
    expect(approved.text()).toContain("Gala Dinner");
    expect(onHold.text()).toContain("Tech Talk");
    expect(onHold.attributes("title")).toContain("On Hold until");
    expect(wrapper.find(".chip--blocked").text()).toContain("All day");
    expect(wrapper.findAll(".month__cell.is-blocked")).toHaveLength(1);
  });

  it("switches to week view and loads that week, with closed hours shown", async () => {
    const { wrapper } = await mountView();
    await wrapper.findAll(".toggle-btn").find((b) => b.text() === "Week")!.trigger("click");
    await flushPromises();

    expect(venuesApi.fetchVenueAvailability).toHaveBeenLastCalledWith(1, "2026-10-05", "2026-10-11", null, expect.anything());
    expect(wrapper.findAll(".week__day")).toHaveLength(7);
    expect(wrapper.findAll(".block--closed").length).toBe(14);
    const approved = wrapper.find(".block--approved");
    expect(approved.attributes("aria-label")).toContain("including setup and turnaround");
    expect(approved.find(".block__core").exists()).toBe(true);
  });

  it("opens a day's week from the month grid", async () => {
    const { wrapper } = await mountView();
    const cell = wrapper.findAll(".month__cell").find((c) => c.attributes("aria-label")?.startsWith("Monday 19 October"))!;
    await cell.trigger("click");
    await flushPromises();
    expect(venuesApi.fetchVenueAvailability).toHaveBeenLastCalledWith(1, "2026-10-19", "2026-10-25", null, expect.anything());
  });

  it("AC5: requests free slots for the target and highlights them", async () => {
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
      "2026-09-28",
      "2026-11-01",
      { fromDate: "2026-10-10", toDate: "2026-10-11", startTime: "12:00", endTime: "18:00" },
      expect.anything(),
    );
    expect(wrapper.find(".slot-chip").text()).toContain("16:45–18:00");
    expect(wrapper.find(".slot-chip").text()).toContain("event 17:15–18:00");
    expect(wrapper.find(".chip--free").exists()).toBe(true);
    expect(router.currentRoute.value.query).toMatchObject({
      tFrom: "2026-10-10", tTo: "2026-10-11", tStart: "12:00", tEnd: "18:00",
    });
  });

  it("AC5: without times, searches each target date's whole operating day", async () => {
    const { wrapper } = await mountView();

    await wrapper.find("#target-from").setValue("2026-10-10");
    await wrapper.find("form.target").trigger("submit");
    await flushPromises();

    expect(venuesApi.fetchVenueAvailability).toHaveBeenLastCalledWith(
      1, "2026-09-28", "2026-11-01",
      { fromDate: "2026-10-10", toDate: "2026-10-10", startTime: null, endTime: null },
      expect.anything(),
    );
  });

  it("places the action buttons in their own row after the target fields", async () => {
    const { wrapper } = await mountView();
    const actions = wrapper.find(".controls__actions");
    expect(actions.exists()).toBe(true);
    expect(wrapper.find("form.target").find(".btn-primary").exists()).toBe(false);
    expect(actions.find(".btn-primary").attributes()).toMatchObject({ type: "submit", form: "target-form" });
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

  it("shows an error when availability can't be loaded", async () => {
    vi.mocked(venuesApi.fetchVenueAvailability).mockRejectedValue(new Error("Failed to load venue availability"));
    const { wrapper } = await mountView();
    expect(wrapper.text()).toContain("Failed to load venue availability");
  });
});
