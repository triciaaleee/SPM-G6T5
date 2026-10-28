import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import VenueStaff from "../VenueStaff.vue";
import VenueCalendar from "../../../components/venues/VenueCalendar.vue";
import {
  fetchBufferOverlaps,
  fetchPendingRequests,
  fetchStaffVenues,
  fetchVenueBookings,
} from "../../../lib/venuesApi";
import BlockOutPanel from "../../../components/venues/BlockOutPanel.vue";
import { deleteUnavailability, fetchUnavailability, type UnavailabilityPeriod } from "../../../lib/unavailabilityApi";

vi.mock("../../../lib/venuesApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/venuesApi")>("../../../lib/venuesApi");
  return {
    ...actual,
    fetchStaffVenues: vi.fn(),
    fetchPendingRequests: vi.fn(),
    fetchVenueBookings: vi.fn(),
    fetchBufferOverlaps: vi.fn(),
  };
});
vi.mock("../../../lib/unavailabilityApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/unavailabilityApi")>("../../../lib/unavailabilityApi");
  return { ...actual, fetchUnavailability: vi.fn(), deleteUnavailability: vi.fn() };
});

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { render: () => h("div") } },
    { path: "/venue-schedule", name: "venue-schedule", component: VenueStaff },
    { path: "/venue-catalogue", name: "venue-catalogue", component: { render: () => h("div") } },
  ],
});

const venueList = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `Venue ${i + 1}` }));

async function mountPage(query = "") {
  await router.push(`/venue-schedule${query}`);
  await router.isReady();
  const wrapper = mount(VenueStaff, {
    global: {
      plugins: [router],
      stubs: { VenueCalendar: true, BlockOutPanel: true, BufferOverlapList: true, VenueRequestRows: true },
    },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchStaffVenues).mockResolvedValue(venueList);
  vi.mocked(fetchPendingRequests).mockResolvedValue([]);
  vi.mocked(fetchVenueBookings).mockResolvedValue([]);
  vi.mocked(fetchBufferOverlaps).mockResolvedValue([]);
  vi.mocked(fetchUnavailability).mockResolvedValue([]);
});

const period = (overrides: Partial<UnavailabilityPeriod> = {}): UnavailabilityPeriod => ({
  id: 1,
  venueId: 2,
  startDate: "2099-06-01",
  endDate: "2099-06-01",
  allDay: true,
  startTime: null,
  endTime: null,
  reason: "Maintenance",
  ...overrides,
});

describe("VenueStaff — list view sections", () => {
  it("stacks upcoming bookings, then unavailable, then flagged booking pairs, each its own full-width section", async () => {
    const wrapper = await mountPage();
    const html = wrapper.html();

    const upcoming = html.indexOf('id="upcoming-title"');
    const unavailable = html.indexOf('id="unavailable-title"');
    const flagged = html.indexOf("buffer-overlap-list-stub");
    expect(upcoming).toBeGreaterThan(-1);
    expect(unavailable).toBeGreaterThan(upcoming);
    expect(flagged).toBeGreaterThan(unavailable);

    expect(wrapper.find(".schedule__sections").exists()).toBe(true);
    expect(wrapper.find("aside").exists()).toBe(false);
    expect(wrapper.find("#unavailable-title").text()).toBe("Unavailable (0)");
    expect(wrapper.find("#upcoming-title").text()).toBe("Upcoming bookings");
  });

  it("says every venue is available when nothing is blocked out", async () => {
    const wrapper = await mountPage();
    expect(wrapper.find("[aria-labelledby='unavailable-title']").text()).toContain("All your venues are available.");

    const some = await mountPage("?venue=1,2");
    expect(some.find("[aria-labelledby='unavailable-title']").text()).toContain("All the selected venues are available.");
  });

  it("lists block-outs in a table with their dates, hours, reason and venue", async () => {
    vi.mocked(fetchUnavailability).mockImplementation(async (venueId: number) =>
      venueId === 2
        ? [
            period({ id: 1, reason: "Maintenance" }),
            period({ id: 2, startDate: "2099-07-01", endDate: "2099-07-03", allDay: false, startTime: "09:00", endTime: "13:00", reason: "Cleaning" }),
          ]
        : [],
    );
    const wrapper = await mountPage();

    expect(wrapper.find("#unavailable-title").text()).toBe("Unavailable (2)");
    const first = wrapper.get("[data-testid='block-1']");
    expect(first.text()).toContain("Maintenance");
    expect(first.text()).toContain("All day");
    expect(first.text()).toContain("Venue 2");
    expect(first.text()).toContain("1 Jun");
    const second = wrapper.get("[data-testid='block-2']");
    expect(second.text()).toContain("09:00 – 13:00");
    expect(second.text()).toContain("1 Jul");
    expect(second.text()).toContain("3 Jul");
    expect(wrapper.find(".block-list .rows__head").text()).toContain("Dates");
  });

  it("puts Venue before Reason in the unavailable table, with outline Edit and Remove buttons", async () => {
    vi.mocked(fetchUnavailability).mockImplementation(async (venueId: number) => (venueId === 2 ? [period({ id: 1 })] : []));
    const wrapper = await mountPage();

    expect(wrapper.findAll(".block-list .rows__head span").map((s) => s.text())).toEqual(["Dates", "Hours", "Venue", "Reason", ""]);
    const cells = wrapper.findAll("[data-testid='block-1'] .row__main > span").map((s) => s.text());
    expect(cells.slice(0, 4)).toEqual(["Mon 1 Jun", "All day", "Venue 2", "Maintenance"]);

    expect(wrapper.get("[data-testid='edit-block']").classes()).toContain("btn--outline");
    expect(wrapper.get("[data-testid='remove-block']").classes()).toContain("btn--danger");
  });

  it("builds the unavailable table from the same rows, columns and width as the bookings table", async () => {
    vi.mocked(fetchUnavailability).mockImplementation(async (venueId: number) => (venueId === 2 ? [period({ id: 1 })] : []));
    vi.mocked(fetchVenueBookings).mockImplementation(async (venueId: number) =>
      venueId === 2
        ? [
            {
              id: 11,
              status: "Approved",
              date: "2099-06-05",
              startTime: "10:00",
              endTime: "12:00",
              event: { id: 1, name: "Alumni Gala", expectedAttendance: 50, layouts: [], facilities: [] },
              setup: null,
            } as never,
          ]
        : [],
    );
    const wrapper = await mountPage();
    await wrapper.get("#tab-bookings").trigger("click");

    const bookings = wrapper.get("[aria-labelledby='upcoming-title'] ul.rows");
    const blocks = wrapper.get("[aria-labelledby='unavailable-title'] ul.rows");
    // Same list, header, row and cell classes, so one stylesheet gives both the same look and width;
    // only the last column is wider (rows--blocks), for the two buttons.
    expect(blocks.classes()).toEqual([...bookings.classes().filter((c) => c !== "is-stale"), "rows--blocks"]);
    expect(blocks.find(".rows__head").exists()).toBe(true);
    expect(blocks.get(".row .row__main").classes()).toEqual(bookings.get(".row .row__main").classes());
    expect(blocks.findAll(".row__main > span, .row__main > button").length).toBe(
      bookings.findAll(".row__main > span, .row__main > button").length,
    );
    expect(wrapper.find("aside").exists()).toBe(false);
  });

  it("opens the block-out form for the period whose Edit is clicked", async () => {
    vi.mocked(fetchUnavailability).mockImplementation(async (venueId: number) => (venueId === 2 ? [period({ id: 7 })] : []));
    const wrapper = await mountPage();

    await wrapper.get("[data-testid='block-7'] [data-testid='edit-block']").trigger("click");

    const panel = wrapper.findComponent(BlockOutPanel);
    expect(panel.exists()).toBe(true);
    expect(panel.props("period")).toMatchObject({ id: 7, reason: "Maintenance" });
  });

  it("removes a block-out after confirming, and reloads the list", async () => {
    vi.mocked(fetchUnavailability).mockImplementation(async (venueId: number) => (venueId === 2 ? [period({ id: 7 })] : []));
    vi.mocked(deleteUnavailability).mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const wrapper = await mountPage();

    vi.mocked(fetchUnavailability).mockResolvedValue([]);
    await wrapper.get("[data-testid='block-7'] [data-testid='remove-block']").trigger("click");
    await flushPromises();

    expect(confirm).toHaveBeenCalled();
    expect(deleteUnavailability).toHaveBeenCalledWith(7);
    expect(wrapper.find("[data-testid='block-7']").exists()).toBe(false);
    expect(wrapper.find("#unavailable-title").text()).toBe("Unavailable (0)");
    confirm.mockRestore();
  });

  it("puts the flagged pairs last in the calendar view too, under the calendar, with no unavailable section", async () => {
    const wrapper = await mountPage("?view=calendar");
    const html = wrapper.html();

    expect(wrapper.find("#unavailable-title").exists()).toBe(false);
    expect(html.indexOf("buffer-overlap-list-stub")).toBeGreaterThan(html.indexOf("venue-calendar-stub"));
  });
});

describe("VenueStaff — header", () => {
  it("has one Venue catalogue button leading to the catalogue, instead of add, edit and block-out buttons", async () => {
    const wrapper = await mountPage();

    const link = wrapper.get("[data-testid='venue-catalogue-link']");
    expect(link.text()).toBe("Venue catalogue");
    expect(link.attributes("href")).toBe("/venue-catalogue");

    const headerButtons = wrapper.findAll(".header-actions a, .header-actions button");
    expect(headerButtons).toHaveLength(1);
    expect(wrapper.text()).not.toContain("Add new venue");
    expect(wrapper.text()).not.toContain("Edit venue");
    expect(wrapper.text()).not.toContain("Block out time");
  });
});

describe("VenueStaff — Calendar | List", () => {
  it("opens on the list: the booking tabs show, the calendar does not", async () => {
    const wrapper = await mountPage();

    expect(wrapper.find("[role='tablist']").exists()).toBe(true);
    expect(wrapper.findComponent(VenueCalendar).exists()).toBe(false);
    expect(wrapper.get("[data-testid='view-list']").attributes("aria-pressed")).toBe("true");
    expect(wrapper.get("[data-testid='view-calendar']").attributes("aria-pressed")).toBe("false");
  });

  it("switches to the calendar, which draws nothing for All venues and asks for venues to be selected", async () => {
    const wrapper = await mountPage();

    await wrapper.get("[data-testid='view-calendar']").trigger("click");

    const calendar = wrapper.findComponent(VenueCalendar);
    expect(calendar.exists()).toBe(true);
    expect(calendar.props("venues")).toHaveLength(0);
    expect(calendar.props("total")).toBe(0);
    expect(calendar.props("prompt")).toBe("Select up to 4 venues above to see the calendar.");
    expect(wrapper.find("[role='tablist']").exists()).toBe(false);
  });

  it("says outside the dropdown that the calendar shows nothing for All venues, only while on the calendar", async () => {
    const wrapper = await mountPage();
    expect(wrapper.find("[data-testid='calendar-venue-hint']").exists()).toBe(false);

    await wrapper.get("[data-testid='view-calendar']").trigger("click");
    expect(wrapper.get("[data-testid='calendar-venue-hint']").text()).toBe(
      "The calendar shows nothing for All venues, so select the venues you want to see.",
    );
    expect(wrapper.find(".picker__popover").exists()).toBe(false);
  });

  it("gives the calendar the venues picked in the filter, with no prompt", async () => {
    const wrapper = await mountPage("?view=calendar&venue=2,3");

    const calendar = wrapper.findComponent(VenueCalendar);
    expect(calendar.props("venues").map((v: { id: number }) => v.id)).toEqual([2, 3]);
    expect(calendar.props("total")).toBe(2);
    expect(calendar.props("prompt")).toBeUndefined();
  });

  it("keeps the chosen view in the address, so a refresh reopens it", async () => {
    const wrapper = await mountPage();
    await wrapper.get("[data-testid='view-calendar']").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.query.view).toBe("calendar");

    await wrapper.get("[data-testid='view-list']").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.query.view).toBeUndefined();

    const reopened = await mountPage("?view=calendar");
    expect(reopened.findComponent(VenueCalendar).exists()).toBe(true);
  });

  it("shows the venue count in the filter, and limits a filter reopened from the address to four venues", async () => {
    const wrapper = await mountPage("?venue=1,2,3,4,5");

    await wrapper.get("[data-testid='view-calendar']").trigger("click");
    expect(wrapper.findComponent(VenueCalendar).props("venues").map((v: { id: number }) => v.id)).toEqual([1, 2, 3, 4]);
    expect(wrapper.find(".picker__trigger").text()).toContain("4 venues");

    const all = await mountPage();
    expect(all.find(".picker__trigger").text()).toContain("All venues (6)");
  });
});
