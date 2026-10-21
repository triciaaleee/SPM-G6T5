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

  it("ignores a request the coordinator cancelled (E5-2): it holds nothing and nobody is waiting on it", () => {
    const onlyCancelled = mountTracker([], [equipmentRequest({ status: "Cancelled" })]);
    expect(equipmentLine(onlyCancelled).text()).toBe("Equipment — not yet requested");

    const withArranged = mountTracker(
      [],
      [equipmentRequest({ id: 500, status: "Arranged" }), equipmentRequest({ id: 501, status: "Cancelled" })],
    );
    expect(withArranged.findAll(".outstanding__item").some((item) => item.text().startsWith("Equipment"))).toBe(false);
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

describe("EventStatusTracker timeline", () => {
  function mountTimeline(status: string, extra: Record<string, unknown> = {}) {
    return mount(EventStatusTracker, {
      props: {
        status,
        lastChangedAt: "2026-10-07T02:00:00.000Z",
        submittedAt: "2026-10-01T02:00:00.000Z",
        reviewOutcome: null,
        showOutstanding: false,
        ...extra,
      },
    });
  }
  const states = (status: string) =>
    mountTimeline(status)
      .findAll(".status-tracker__step")
      .map((step) => step.attributes("data-state"));

  it("has one column per lifecycle stage, named exactly as in the lifecycle", () => {
    const labels = mountTimeline("Planning")
      .findAll(".status-tracker__label")
      .map((label) => label.text());
    expect(labels).toEqual(["Requested", "Planning", "Safety Review", "Confirmed", "Completed"]);
  });

  it("gives Safety Review its own step after Planning (E3-4)", () => {
    const wrapper = mountTimeline("Safety Review");
    const steps = wrapper.findAll(".status-tracker__step");

    expect(states("Safety Review")).toEqual(["complete", "complete", "current", "pending", "pending"]);
    expect(steps[2].text()).toContain("Safety Review");
    expect(wrapper.text()).toContain("Operational Safety Check");
  });

  it("shows Planning as the current step while the event is in Planning", () => {
    expect(states("Planning")).toEqual(["complete", "current", "pending", "pending", "pending"]);
  });

  it("marks Confirmed as the current stage once safety-approved (E3-5)", () => {
    expect(states("Confirmed")).toEqual(["complete", "complete", "complete", "current", "pending"]);
  });

  it("marks every stage done once the event is Completed (E3-5)", () => {
    expect(states("Completed")).toEqual(["complete", "complete", "complete", "complete", "complete"]);
  });

  it("captions each step: Done with the submitted date, Current step, Not started", () => {
    const captions = mountTimeline("Planning")
      .findAll(".status-tracker__caption")
      .map((caption) => caption.text());
    expect(captions).toEqual(["Done, 1 Oct 2026", "Current step", "Not started", "Not started", "Not started"]);
  });

  it("says just Done when there is no date to show", () => {
    const caption = mountTimeline("Planning", { submittedAt: null }).findAll(".status-tracker__caption")[0];
    expect(caption.text()).toBe("Done");
  });

  it("draws a tick for done steps, a ringed dot for the current one and a number for the rest", () => {
    const steps = mountTimeline("Planning").findAll(".status-tracker__step");
    expect(steps[0].find(".status-tracker__tick").exists()).toBe(true);
    expect(steps[1].find(".status-tracker__inner").exists()).toBe(true);
    expect(steps[2].find(".status-tracker__dot").text()).toBe("3");
    // No connector after the last step.
    expect(steps[4].find(".status-tracker__line").exists()).toBe(false);
    expect(steps[0].find(".status-tracker__line").exists()).toBe(true);
  });

  it("relabels stage two while clarification is awaited", () => {
    const steps = mountTimeline("Clarification Requested").findAll(".status-tracker__step");
    expect(steps[1].text()).toContain("Clarification Requested");
    expect(steps[1].attributes("data-state")).toBe("current");
  });

  it("ends the line at a Rejected step", () => {
    const wrapper = mountTimeline("Rejected", { reviewOutcome: "Venue unavailable" });
    const steps = wrapper.findAll(".status-tracker__step");
    expect(steps).toHaveLength(2);
    expect(steps[1].text()).toContain("Rejected");
    expect(wrapper.text()).toContain("This request was rejected: Venue unavailable");
  });

  it("hides the steps for a Cancelled event and says why", () => {
    const wrapper = mountTimeline("Cancelled", { reviewOutcome: "Speaker pulled out" });
    expect(wrapper.findAll(".status-tracker__step")).toHaveLength(0);
    expect(wrapper.text()).toContain("This event was cancelled: Speaker pulled out");
  });

  it("sits bare on the page: no card, title or 'last updated' line", () => {
    const wrapper = mountTimeline("Planning", { title: "Event Timeline" });
    expect(wrapper.find(".details-card").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("Event Timeline");
    expect(wrapper.text()).not.toContain("Last updated");
  });
});

describe("EventStatusTracker — Needs Review", () => {
  it("shares Confirmed's slot, labelled Needs Review, with the info variant and an explanation", () => {
    const wrapper = mount(EventStatusTracker, {
      props: { status: "Needs Review", lastChangedAt: "2026-10-07T02:00:00.000Z", reviewOutcome: null },
    });

    const labels = wrapper.findAll(".status-tracker__label").map((label) => label.text());
    expect(labels).toEqual(["Requested", "Planning", "Safety Review", "Needs Review", "Completed"]);
    const current = wrapper.find(".status-tracker__step[data-state='current']");
    expect(current.text()).toContain("Needs Review");
    expect(wrapper.text()).toContain("returns to");
  });

  it("lists outstanding arrangements while in Needs Review", () => {
    const wrapper = mount(EventStatusTracker, {
      props: {
        status: "Needs Review",
        lastChangedAt: "2026-10-07T02:00:00.000Z",
        reviewOutcome: null,
        showTimeline: false,
        venueBookings: [booking({ status: "Replacement Required" })],
        equipmentRequests: [],
      },
    });
    expect(wrapper.find(".outstanding").exists()).toBe(true);
  });
});
