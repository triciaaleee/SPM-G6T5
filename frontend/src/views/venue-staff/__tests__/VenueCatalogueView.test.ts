import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VenueCatalogueView from "../VenueCatalogueView.vue";
import VenueFormPanel from "../../../components/venues/VenueFormPanel.vue";
import BlockOutPanel from "../../../components/venues/BlockOutPanel.vue";
import { fetchMyVenues, type VenueRecord } from "../../../lib/venuesApi";
import type { CreatePeriodResult } from "../../../lib/unavailabilityApi";

vi.mock("../../../lib/venuesApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/venuesApi")>("../../../lib/venuesApi");
  return { ...actual, fetchMyVenues: vi.fn() };
});

const mockedVenues = vi.mocked(fetchMyVenues);

function venue(overrides: Partial<VenueRecord> = {}): VenueRecord {
  return {
    id: 1,
    name: "Great Lawn",
    location: "North Campus",
    description: "Outdoor lawn",
    capacity: 300,
    accessibility: [],
    layouts: [],
    facilities: [],
    setupMinutes: 30,
    turnaroundMinutes: 30,
    openingTime: "08:00",
    closingTime: "22:00",
    status: "Available",
    ...overrides,
  };
}

async function mountView(venues: VenueRecord[] = [venue(), venue({ id: 2, name: "Grand Ballroom", capacity: 500 })]) {
  mockedVenues.mockResolvedValue(venues);
  const wrapper = mount(VenueCatalogueView, { global: { stubs: { VenueFormPanel: true, BlockOutPanel: true } } });
  await flushPromises();
  return wrapper;
}

function blockOutResult(overrides: Partial<CreatePeriodResult> = {}): CreatePeriodResult {
  return {
    period: {
      id: 5,
      venueId: 2,
      startDate: "2099-06-01",
      endDate: "2099-06-01",
      allDay: true,
      startTime: null,
      endTime: null,
      reason: "Maintenance",
    },
    affected: [],
    coordinatorsNotified: 0,
    notificationsFailed: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VenueCatalogueView", () => {
  it("lists every venue in a table with its location, capacity, hours and status", async () => {
    const wrapper = await mountView();

    const first = wrapper.find("[data-testid='venue-1']");
    expect(first.text()).toContain("Great Lawn");
    expect(first.text()).toContain("North Campus");
    expect(first.find("[data-testid='venue-capacity']").text()).toBe("300");
    expect(first.text()).toContain("08:00 – 22:00");
    expect(first.text()).toContain("Available");
    expect(wrapper.find("[data-testid='venue-2']").text()).toContain("Grand Ballroom");
  });

  it("says so when there are no venues yet", async () => {
    const wrapper = await mountView([]);
    expect(wrapper.text()).toContain("No venues have been added yet.");
  });

  it("shows an error when the venues can't be loaded", async () => {
    mockedVenues.mockRejectedValue(new Error("down"));
    const wrapper = mount(VenueCatalogueView, { global: { stubs: { VenueFormPanel: true } } });
    await flushPromises();
    expect(wrapper.find("[role='alert']").text()).toContain("couldn't load the venues");
  });

  it("opens the add-venue form from the top-right button, and closes it again", async () => {
    const wrapper = await mountView();
    expect(wrapper.findComponent(VenueFormPanel).exists()).toBe(false);

    const button = wrapper.find("[data-testid='open-add-venue']");
    expect(button.text()).toBe("Add venue");
    expect(button.classes()).toContain("btn--xl");
    await button.trigger("click");
    expect(wrapper.findComponent(VenueFormPanel).exists()).toBe(true);

    wrapper.findComponent(VenueFormPanel).vm.$emit("close");
    await flushPromises();
    expect(wrapper.findComponent(VenueFormPanel).exists()).toBe(false);
  });

  it("opens the form pre-filled for that venue from a row's Edit button, then re-reads the list once it is saved", async () => {
    const wrapper = await mountView();

    await wrapper.find("[data-testid='venue-2'] [data-testid='edit-venue']").trigger("click");
    const panel = wrapper.findComponent(VenueFormPanel);
    expect(panel.exists()).toBe(true);
    expect(panel.props("venue")).toMatchObject({ id: 2, name: "Grand Ballroom" });

    const renamed = venue({ id: 2, name: "Grand Ballroom East", capacity: 450 });
    mockedVenues.mockResolvedValue([venue(), renamed]);
    panel.vm.$emit("updated", {
      venue: renamed,
      capacityShortfalls: [],
      bufferOverlaps: [],
      coordinatorsNotified: 0,
      notificationsFailed: false,
    });
    await flushPromises();

    expect(wrapper.findComponent(VenueFormPanel).exists()).toBe(false);
    expect(wrapper.find("[data-testid='venue-notice']").text()).toBe("Grand Ballroom East updated.");
    expect(wrapper.find("[data-testid='venue-2']").text()).toContain("Grand Ballroom East");
  });

  it("puts a Block out button beside Edit that opens the block-out form for just that venue, defaulting to today", async () => {
    const wrapper = await mountView();
    expect(wrapper.findComponent(BlockOutPanel).exists()).toBe(false);

    const row = wrapper.find("[data-testid='venue-2']");
    const buttons = row.findAll(".row-actions button").map((b) => b.text());
    expect(buttons).toEqual(["Edit", "Block out"]);

    await row.find("[data-testid='block-out-venue']").trigger("click");
    const panel = wrapper.findComponent(BlockOutPanel);
    expect(panel.exists()).toBe(true);
    expect(panel.props("venueId")).toBe(2);
    expect(panel.props("venues")).toEqual([expect.objectContaining({ id: 2, name: "Grand Ballroom" })]);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    expect(panel.props("initialDate")).toBe(today);

    panel.vm.$emit("close");
    await flushPromises();
    expect(wrapper.findComponent(BlockOutPanel).exists()).toBe(false);
  });

  it("closes the block-out form and says what the block-out did once it is saved", async () => {
    const wrapper = await mountView();

    await wrapper.find("[data-testid='venue-2'] [data-testid='block-out-venue']").trigger("click");
    wrapper.findComponent(BlockOutPanel).vm.$emit("saved", blockOutResult());
    await flushPromises();

    expect(wrapper.findComponent(BlockOutPanel).exists()).toBe(false);
    expect(wrapper.find("[data-testid='venue-notice']").text()).toBe(
      "Period blocked out. It shows as unavailable on the calendar.",
    );
    expect(wrapper.find("[data-testid='venue-notice']").classes()).not.toContain("notice--warning");

    await wrapper.find("[data-testid='venue-2'] [data-testid='block-out-venue']").trigger("click");
    wrapper.findComponent(BlockOutPanel).vm.$emit(
      "saved",
      blockOutResult({
        affected: [
          {
            bookingId: 1,
            status: "Approved",
            eventId: 1,
            eventName: "Alumni Gala",
            date: "2099-06-01",
            startTime: "10:00",
            endTime: "12:00",
            occupiedStart: "10:00",
            occupiedEnd: "12:00",
            hasCoordinator: true,
            replacementRequired: true,
          },
        ],
        notificationsFailed: true,
      }),
    );
    await flushPromises();

    const notice = wrapper.find("[data-testid='venue-notice']");
    expect(notice.text()).toContain("1 booking cancelled");
    expect(notice.text()).toContain("couldn't notify the coordinators");
    expect(notice.classes()).toContain("notice--warning");
  });

  it("opens the add form blank, not pre-filled, after editing a venue", async () => {
    const wrapper = await mountView();

    await wrapper.find("[data-testid='venue-1'] [data-testid='edit-venue']").trigger("click");
    wrapper.findComponent(VenueFormPanel).vm.$emit("close");
    await flushPromises();
    await wrapper.find("[data-testid='open-add-venue']").trigger("click");

    expect(wrapper.findComponent(VenueFormPanel).props("venue")).toBeNull();
  });

  it("closes the form, says the venue was added and re-reads the list once it is created", async () => {
    const wrapper = await mountView([venue()]);
    await wrapper.find("[data-testid='open-add-venue']").trigger("click");

    const added = venue({ id: 3, name: "Innovation Hub" });
    mockedVenues.mockResolvedValue([venue(), added]);
    wrapper.findComponent(VenueFormPanel).vm.$emit("created", added);
    await flushPromises();

    expect(wrapper.findComponent(VenueFormPanel).exists()).toBe(false);
    expect(wrapper.find("[data-testid='venue-notice']").text()).toContain("Innovation Hub added");
    expect(wrapper.find("[data-testid='venue-3']").exists()).toBe(true);
    expect(mockedVenues).toHaveBeenCalledTimes(2);
  });
});
