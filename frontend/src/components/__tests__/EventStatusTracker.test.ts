import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import EventStatusTracker from "../EventStatusTracker.vue";
import type { EventVenueBooking } from "../../lib/venuesApi";
import type { EquipmentRequest } from "../../lib/equipmentApi";

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

function equipmentRequest(overrides: Partial<EquipmentRequest> = {}): EquipmentRequest {
  return {
    id: 500,
    eventId: 7,
    status: "Requested",
    fulfillmentNote: null,
    createdAt: "2026-10-07T02:00:00.000Z",
    items: [],
    ...overrides,
  };
}

function mountTracker(venueBookings?: EventVenueBooking[], equipmentRequests?: EquipmentRequest[]) {
  return mount(EventStatusTracker, {
    props: {
      status: "Planning",
      lastChangedAt: "2026-10-07T02:00:00.000Z",
      reviewOutcome: null,
      showTimeline: false,
      venueBookings,
      equipmentRequests,
    },
  });
}

/** The venue line is the first of the two outstanding items. */
function venueLine(wrapper: ReturnType<typeof mountTracker>) {
  return wrapper.findAll(".outstanding__item")[0];
}

/** The equipment line is the second of the two outstanding items. */
function equipmentLine(wrapper: ReturnType<typeof mountTracker>) {
  return wrapper.findAll(".outstanding__item")[1];
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

  it("doesn't claim equipment is missing before the requests have loaded", () => {
    const wrapper = mountTracker([], undefined);
    expect(equipmentLine(wrapper).text()).toBe("Equipment — checking…");
  });

  it("says nothing is requested when the event has no equipment requests", () => {
    const wrapper = mountTracker([], []);
    expect(equipmentLine(wrapper).text()).toBe("Equipment — not yet requested");
  });

  it("stays outstanding while a request is still awaiting Technical Support", () => {
    const wrapper = mountTracker([], [equipmentRequest({ status: "Requested" })]);
    expect(equipmentLine(wrapper).text()).toBe("Equipment — 1 awaiting Technical Support");
    expect(equipmentLine(wrapper).classes()).not.toContain("outstanding__item--done");
  });

  it("stays outstanding while a request is only partially fulfilled", () => {
    const wrapper = mountTracker([], [equipmentRequest({ status: "Partially Fulfilled" })]);
    expect(equipmentLine(wrapper).text()).toBe("Equipment — 1 awaiting Technical Support");
  });

  it("drops the equipment line entirely once every request is Arranged", () => {
    const wrapper = mountTracker(
      [],
      [equipmentRequest({ id: 500, status: "Arranged" }), equipmentRequest({ id: 501, status: "Arranged" })],
    );
    expect(wrapper.findAll(".outstanding__item")).toHaveLength(1);
    expect(wrapper.text()).not.toContain("Equipment");
  });

  it("E3-4: a booking that needs a replacement venue keeps the venue outstanding", () => {
    const wrapper = mountTracker([booking({ status: "Approved" }), booking({ id: 901, status: "Replacement Required" })]);
    expect(venueLine(wrapper).text()).toBe("Venue — 1 needs a replacement");
    expect(venueLine(wrapper).classes()).not.toContain("outstanding__item--done");
  });

  it("stays outstanding when one of several requests isn't Arranged yet", () => {
    const wrapper = mountTracker(
      [],
      [equipmentRequest({ id: 500, status: "Arranged" }), equipmentRequest({ id: 501, status: "Requested" })],
    );
    expect(equipmentLine(wrapper).text()).toBe("Equipment — 1 awaiting Technical Support");
    expect(equipmentLine(wrapper).classes()).not.toContain("outstanding__item--done");
  });
});

describe("EventStatusTracker timeline (E3-4)", () => {
  function mountTimeline(status: string) {
    return mount(EventStatusTracker, {
      props: { status, lastChangedAt: "2026-10-07T02:00:00.000Z", reviewOutcome: null, showOutstanding: false },
    });
  }

  it("places Safety Review after Requested, not back at the start", () => {
    const wrapper = mountTimeline("Safety Review");
    const steps = wrapper.findAll(".status-tracker__step");

    expect(steps[0].attributes("data-state")).toBe("complete");
    expect(steps[1].attributes("data-state")).toBe("current");
    expect(steps[1].text()).toContain("Safety Review");
    expect(wrapper.text()).toContain("Operational Safety Check");
  });

  it("still labels stage two Planning while the event is in Planning", () => {
    const steps = mountTimeline("Planning").findAll(".status-tracker__step");
    expect(steps[1].text()).toContain("Planning");
    expect(steps[1].attributes("data-state")).toBe("current");
  });
});
