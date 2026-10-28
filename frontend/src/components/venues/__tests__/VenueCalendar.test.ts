import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VenueCalendar from "../VenueCalendar.vue";
import { fetchVenueBookings, type StaffVenueOption } from "../../../lib/venuesApi";
import { fetchUnavailability } from "../../../lib/unavailabilityApi";

vi.mock("../../../lib/venuesApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/venuesApi")>("../../../lib/venuesApi");
  return { ...actual, fetchVenueBookings: vi.fn() };
});
vi.mock("../../../lib/unavailabilityApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/unavailabilityApi")>("../../../lib/unavailabilityApi");
  return { ...actual, fetchUnavailability: vi.fn() };
});

const mockedBookings = vi.mocked(fetchVenueBookings);
const mockedBlocks = vi.mocked(fetchUnavailability);

const venues: StaffVenueOption[] = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `Venue ${i + 1}` }));

async function mountCalendar(props: Record<string, unknown> = {}) {
  const wrapper = mount(VenueCalendar, { props: { venues, total: venues.length, ...props } });
  await flushPromises();
  return wrapper;
}

/** The calendar's own Day / Week / Month switch. */
async function chooseView(wrapper: Awaited<ReturnType<typeof mountCalendar>>, label: "Day" | "Week" | "Month") {
  await wrapper.findAll(".segmented button").find((b) => b.text() === label)!.trigger("click");
  await flushPromises();
}

const venuesFetched = () => new Set(mockedBookings.mock.calls.map(([id]) => id));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockedBookings.mockResolvedValue([]);
  mockedBlocks.mockResolvedValue([]);
});

describe("VenueCalendar — a coordinator's read-only use", () => {
  const entry = {
    id: "booking-1",
    kind: "booking" as const,
    venueId: 1,
    date: "2026-10-10",
    startMin: 600,
    endMin: 720,
    title: "Gala Dinner",
    status: "Approved" as const,
    startTime: "10:00",
    endTime: "12:00",
    allDay: false,
  };

  it("takes its entries from loadEntries and leaves the staff endpoints alone", async () => {
    const loadEntries = vi.fn().mockResolvedValue({ bookings: [entry], blocks: [] });
    const wrapper = await mountCalendar({ venues: venues.slice(0, 1), day: "2026-10-10", loadEntries });

    expect(loadEntries).toHaveBeenCalledWith(1, "2026-10-05", "2026-10-11");
    expect(mockedBookings).not.toHaveBeenCalled();
    expect(mockedBlocks).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Gala Dinner");
  });

  it("reports a venue whose loader fails, and still draws the rest", async () => {
    const loadEntries = vi.fn(async (id: number) => {
      if (id === 2) throw new Error("boom");
      return { bookings: [{ ...entry, venueId: id }], blocks: [] };
    });
    const wrapper = await mountCalendar({ venues: venues.slice(0, 2), day: "2026-10-10", loadEntries });

    expect(wrapper.find("[role='alert']").text()).toContain("Venue 2");
    expect(wrapper.text()).toContain("Gala Dinner");
  });

  it("lists only the statuses it is given in the key", async () => {
    const wrapper = await mountCalendar({ statuses: ["approved", "hold", "block"] });

    expect(wrapper.findAll("ul[aria-label='Status'] .legend__item").map((li) => li.text())).toEqual([
      "Approved",
      "On Hold",
      "Unavailable",
    ]);
  });

  it("lists all five statuses by default", async () => {
    const wrapper = await mountCalendar();

    expect(wrapper.findAll("ul[aria-label='Status'] .legend__item")).toHaveLength(5);
  });

  it("hides Review in Requests and the attendance row when not reviewable", async () => {
    const requested = { ...entry, status: "Requested" as const };
    const loadEntries = vi.fn().mockResolvedValue({ bookings: [requested], blocks: [] });
    const wrapper = await mountCalendar({
      venues: venues.slice(0, 1),
      day: "2026-10-10",
      loadEntries,
      reviewable: false,
    });

    await wrapper.find(".entry").trigger("click");

    expect(wrapper.find("[role='dialog']").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("Review in Requests");
    expect(wrapper.text()).not.toContain("Expected attendance");
  });
});

describe("VenueCalendar — how many venues it draws", () => {
  it("draws only the first four venues in Week view, and says the rest are there in Month", async () => {
    const wrapper = await mountCalendar();

    expect(venuesFetched()).toEqual(new Set([1, 2, 3, 4]));
    expect(wrapper.find(".cap-note").text()).toContain("Showing 4 of 6 venues in Week view");
    expect(wrapper.find(".cap-note").text()).toContain("Month shows all of them");
  });

  it("caps Day view the same way", async () => {
    const wrapper = await mountCalendar();
    await chooseView(wrapper, "Day");

    expect(wrapper.find(".cap-note").text()).toContain("Showing 4 of 6 venues in Day view");
  });

  it("draws every venue in Month view, with no cap note", async () => {
    const wrapper = await mountCalendar();
    await chooseView(wrapper, "Month");

    expect(venuesFetched()).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(wrapper.find(".cap-note").exists()).toBe(false);
  });

  it("keeps a per-venue colour key while there are four or fewer, and drops it once colours would repeat", async () => {
    const few = await mountCalendar({ venues: venues.slice(0, 3), total: 3 });
    expect(few.findAll(".swatch")).toHaveLength(3);

    const many = await mountCalendar();
    await chooseView(many, "Month");
    expect(many.findAll(".swatch")).toHaveLength(0);
  });

  it("respects a different maxVenues", async () => {
    await mountCalendar({ maxVenues: 2 });

    expect(venuesFetched()).toEqual(new Set([1, 2]));
  });
});

describe("VenueCalendar — the key", () => {
  const groupOf = (wrapper: Awaited<ReturnType<typeof mountCalendar>>, name: string) =>
    wrapper.find(`.legend [aria-label='${name}']`);

  it("has a Venue group of left-edge bars and a Status group naming the five statuses, each with an icon", async () => {
    const wrapper = await mountCalendar({ venues: venues.slice(0, 2), total: 2 });

    expect(groupOf(wrapper, "Venue").findAll(".legend__item").map((li) => li.text())).toEqual(["Venue 1", "Venue 2"]);
    expect(groupOf(wrapper, "Venue").findAll(".swatch").map((s) => s.classes())).toEqual([
      expect.arrayContaining(["swatch--slot-0"]),
      expect.arrayContaining(["swatch--slot-1"]),
    ]);

    const statuses = groupOf(wrapper, "Status").findAll(".legend__item");
    expect(statuses.map((li) => li.text())).toEqual([
      "Approved",
      "On Hold",
      "Requested",
      "Replacement Required",
      "Unavailable",
    ]);
    expect(statuses.map((li) => li.find(".key").classes())).toEqual([
      expect.arrayContaining(["key--approved"]),
      expect.arrayContaining(["key--hold"]),
      expect.arrayContaining(["key--requested"]),
      expect.arrayContaining(["key--replace"]),
      expect.arrayContaining(["key--block"]),
    ]);
    for (const li of statuses) expect(li.find(".key svg").exists()).toBe(true);
  });

  it("drops the Venue group, keeping the statuses, once there are more venues than colours", async () => {
    const wrapper = await mountCalendar();
    await chooseView(wrapper, "Month");

    expect(groupOf(wrapper, "Venue").exists()).toBe(false);
    expect(wrapper.find(".legend__divider").exists()).toBe(false);
    expect(groupOf(wrapper, "Status").findAll(".legend__item")).toHaveLength(5);
  });
});
