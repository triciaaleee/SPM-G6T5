import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import VenueTimeSlotGrid from "../VenueTimeSlotGrid.vue";
import type { Venue, VenueAvailability } from "../../../lib/venuesApi";

function makeVenue(overrides: Partial<Venue> = {}): Venue {
  return {
    id: 1,
    name: "Lecture Theatre LT1",
    location: "Central Campus",
    description: null,
    capacity: 120,
    accessibility: [],
    layouts: [],
    facilities: [],
    ...overrides,
  };
}

function makeAvailability(overrides: Partial<VenueAvailability> = {}): VenueAvailability {
  return {
    venue: {
      id: 1,
      name: "Lecture Theatre LT1",
      location: "Central Campus",
      capacity: 120,
      setupMinutes: 0,
      turnaroundMinutes: 0,
      openingTime: "08:00",
      closingTime: "20:00",
    },
    bookings: [],
    unavailability: [],
    target: null,
    freeSlots: [],
    ...overrides,
  };
}

function mountGrid(props: Partial<InstanceType<typeof VenueTimeSlotGrid>["$props"]> = {}) {
  const venue = makeVenue();
  return mount(VenueTimeSlotGrid, {
    props: {
      venues: [venue],
      date: "2026-09-01",
      availability: new Map([[venue.id, makeAvailability()]]),
      eventWindow: null,
      selectedVenueId: null,
      ...props,
    },
  });
}

describe("VenueTimeSlotGrid", () => {
  it("shows a Booked segment for a booking and an Available segment for a free slot", () => {
    const venue = makeVenue();
    const data = makeAvailability({
      bookings: [
        {
          id: 1,
          status: "Approved",
          date: "2026-09-01",
          startTime: "08:00",
          endTime: "10:00",
          occupiedStart: "08:00",
          occupiedEnd: "10:00",
          holdExpiresAt: null,
          event: { id: 1, name: "Orientation" },
        },
      ],
      freeSlots: [{ date: "2026-09-01", start: "10:00", end: "13:30", eventStart: "10:00", eventEnd: "13:30" }],
    });
    const wrapper = mountGrid({ venues: [venue], availability: new Map([[venue.id, data]]) });

    const segments = wrapper.findAll(".segment");
    const labels = segments.map((s) => s.find(".segment__label").text());
    expect(labels).toContain("Booked");
    expect(labels).toContain("Available");
  });

  it("emits select with the slot's start/end when an Available segment is clicked", async () => {
    const venue = makeVenue();
    const data = makeAvailability({
      freeSlots: [{ date: "2026-09-01", start: "10:00", end: "13:30", eventStart: "10:00", eventEnd: "13:30" }],
    });
    const wrapper = mountGrid({ venues: [venue], availability: new Map([[venue.id, data]]) });

    await wrapper.find(".segment--available").trigger("click");

    expect(wrapper.emitted("select")).toEqual([[venue.id, "10:00", "13:30"]]);
  });

  it("does not emit select when a Booked segment is clicked", async () => {
    const venue = makeVenue();
    const data = makeAvailability({
      bookings: [
        {
          id: 1,
          status: "Approved",
          date: "2026-09-01",
          startTime: "08:00",
          endTime: "10:00",
          occupiedStart: "08:00",
          occupiedEnd: "10:00",
          holdExpiresAt: null,
          event: { id: 1, name: "Orientation" },
        },
      ],
    });
    const wrapper = mountGrid({ venues: [venue], availability: new Map([[venue.id, data]]) });

    await wrapper.find(".segment--booked").trigger("click");

    expect(wrapper.emitted("select")).toBeUndefined();
  });

  it("shows the selected segment as Selected when selectedVenueId matches", () => {
    const venue = makeVenue();
    const data = makeAvailability({
      freeSlots: [{ date: "2026-09-01", start: "10:00", end: "13:30", eventStart: "10:00", eventEnd: "13:30" }],
    });
    const wrapper = mountGrid({ venues: [venue], availability: new Map([[venue.id, data]]), selectedVenueId: venue.id });

    const selected = wrapper.find(".segment--selected");
    expect(selected.exists()).toBe(true);
    expect(selected.find(".segment__label").text()).toBe("Selected");
  });

  it("shows hours before opening as Closed, not Booked", () => {
    const venue = makeVenue();
    const data = makeAvailability({ venue: { ...makeAvailability().venue, openingTime: "08:00", closingTime: "20:00" } });
    const wrapper = mountGrid({ venues: [venue], availability: new Map([[venue.id, data]]) });

    const closed = wrapper.find(".segment--closed");
    expect(closed.exists()).toBe(true);
    expect(closed.find(".segment__label").text()).toBe("Closed");
    expect(closed.attributes("style")).toContain("left: 0%");
    expect(wrapper.findAll(".segment--booked")).toHaveLength(0);
  });

  it("shows one row per venue", () => {
    const venueA = makeVenue({ id: 1, name: "Lecture Theatre LT1" });
    const venueB = makeVenue({ id: 2, name: "Rooftop Terrace" });
    const wrapper = mountGrid({
      venues: [venueA, venueB],
      availability: new Map([
        [venueA.id, makeAvailability()],
        [venueB.id, makeAvailability({ venue: { ...makeAvailability().venue, id: 2, name: "Rooftop Terrace" } })],
      ]),
    });

    const rows = wrapper.findAll(".grid__row");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("Lecture Theatre LT1");
    expect(rows[1].text()).toContain("Rooftop Terrace");
  });
});
