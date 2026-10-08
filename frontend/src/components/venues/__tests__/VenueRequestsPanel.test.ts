import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import VenueRequestsPanel from "../VenueRequestsPanel.vue";
import type { EventVenueBooking } from "../../../lib/venuesApi";

function makeBooking(overrides: Partial<EventVenueBooking> = {}): EventVenueBooking {
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

function mountPanel(
  props: Partial<{ bookings: EventVenueBooking[] | undefined; loading: boolean; loadError: string | null }> = {},
) {
  return mount(VenueRequestsPanel, {
    props: { bookings: [], loading: false, loadError: null, ...props },
  });
}

describe("VenueRequestsPanel", () => {
  it("AC5: shows each requested venue and its pending state", () => {
    const wrapper = mountPanel({
      bookings: [
        makeBooking(),
        makeBooking({
          id: 901,
          status: "Approved",
          venue: { id: 2, name: "Seminar Room 3-01", location: "North Campus" },
        }),
      ],
    });

    const rows = wrapper.findAll(".request-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("Grand Ballroom");
    expect(rows[0].find(".badge").text()).toBe("Requested");
    expect(rows[0].find(".badge").classes()).toContain("status-warning");
    expect(rows[1].find(".badge").text()).toBe("Approved");
    expect(rows[1].find(".badge").classes()).toContain("status-success");
  });

  it("shows when a hold expires", () => {
    const wrapper = mountPanel({
      bookings: [makeBooking({ status: "On Hold", holdExpiresAt: "2026-10-09T02:00:00.000Z" })],
    });

    expect(wrapper.text()).toContain("Hold expires");
  });

  it("E4-10 AC4: shows why Venue Staff refused a request", () => {
    const wrapper = mountPanel({
      bookings: [makeBooking({ status: "Rejected", decisionReason: "Floor resurfacing that week" })],
    });

    expect(wrapper.text()).toContain("Reason: Floor resurfacing that week");
  });

  it("says so when no venue has been requested yet", () => {
    expect(mountPanel().text()).toContain("No venue has been requested for this event yet.");
  });

  it("waits rather than claiming nothing is booked before the bookings arrive", () => {
    const wrapper = mountPanel({ bookings: undefined });
    expect(wrapper.text()).toContain("Loading venue requests…");
    expect(wrapper.text()).not.toContain("No venue has been requested");
  });

  it("surfaces a load failure passed down from the page", () => {
    const wrapper = mountPanel({ loadError: "Failed to load this event's venue requests" });
    expect(wrapper.find(".error-text").text()).toBe("Failed to load this event's venue requests");
  });
});
