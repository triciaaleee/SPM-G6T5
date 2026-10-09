import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import EventStatusTracker from "../EventStatusTracker.vue";
import type { EventVenueBooking } from "../../lib/venuesApi";

function booking(overrides: Partial<EventVenueBooking> = {}): EventVenueBooking {
  return {
    id: 900,
    status: "Requested",
    holdExpiresAt: null,
    decisionReason: null,
    createdAt: "2026-10-07T02:00:00.000Z",
    venue: { id: 1, name: "Grand Ballroom", location: "Central Campus" },
    ...overrides,
  };
}

function mountTracker(venueBookings?: EventVenueBooking[]) {
  return mount(EventStatusTracker, {
    props: {
      status: "Planning",
      lastChangedAt: "2026-10-07T02:00:00.000Z",
      reviewOutcome: null,
      showTimeline: false,
      venueBookings,
    },
  });
}

/** The venue line is the first of the two outstanding items. */
function venueLine(wrapper: ReturnType<typeof mountTracker>) {
  return wrapper.findAll(".outstanding__item")[0];
}

describe("EventStatusTracker — outstanding arrangements (E3-1 AC3)", () => {
  it("names the venue and marks it done once a booking is approved", () => {
    const wrapper = mountTracker([booking({ status: "Approved" })]);

    expect(venueLine(wrapper).text()).toBe("Venue — Grand Ballroom");
    expect(venueLine(wrapper).classes()).toContain("outstanding__item--done");
  });

  it("lists every approved venue when the event books more than one", () => {
    const wrapper = mountTracker([
      booking({ status: "Approved" }),
      booking({ id: 901, status: "Approved", venue: { id: 2, name: "Innovation Hub", location: "North Campus" } }),
    ]);

    expect(venueLine(wrapper).text()).toBe("Venue — Grand Ballroom, Innovation Hub");
  });

  it("stays outstanding while another venue is still awaiting a decision", () => {
    const wrapper = mountTracker([booking({ status: "Approved" }), booking({ id: 901, status: "Requested" })]);

    expect(venueLine(wrapper).text()).toBe("Venue — 1 awaiting Venue Staff");
    expect(venueLine(wrapper).classes()).not.toContain("outstanding__item--done");
  });

  it("calls out a tentative hold, which is not yet a booking", () => {
    const wrapper = mountTracker([booking({ status: "On Hold", holdExpiresAt: "2026-10-10T00:00:00.000Z" })]);

    expect(venueLine(wrapper).text()).toBe("Venue — 1 on hold");
    expect(venueLine(wrapper).classes()).not.toContain("outstanding__item--done");
  });

  it.each(["Rejected", "Expired", "Withdrawn"] as const)(
    "goes back to not booked when the only booking is %s",
    (status) => {
      const wrapper = mountTracker([booking({ status, decisionReason: "no" })]);
      expect(venueLine(wrapper).text()).toBe("Venue — not yet booked");
    },
  );

  it("says nothing is booked when the event has no bookings", () => {
    expect(venueLine(mountTracker([])).text()).toBe("Venue — not yet booked");
  });

  it("doesn't claim a venue is missing before the bookings have loaded", () => {
    expect(venueLine(mountTracker(undefined)).text()).toBe("Venue — checking…");
  });

  it("leaves equipment as a placeholder — epic E5 has no service to read", () => {
    const wrapper = mountTracker([booking({ status: "Approved" })]);
    expect(wrapper.findAll(".outstanding__item")[1].text()).toBe("Equipment — not yet arranged");
  });
});
