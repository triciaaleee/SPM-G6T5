import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import BookingPlanForm from "../BookingPlanForm.vue";
import VenueRequestsPanel from "../VenueRequestsPanel.vue";
import {
  planFromQuery,
  planRouteQuery,
  type BookingPlan,
  type BookingSuitability,
  type EventVenueBooking,
} from "../../../lib/venuesApi";

/** E4-17: each venue booking is planned and checked on its own purpose and headcount. */

const defaults = {
  attendance: 300,
  requirements: { layouts: ["Banquet"], facilities: ["PA system"], accessibility: [] },
};

function mountForm(liveBookingCount: number) {
  return mount(BookingPlanForm, {
    props: { defaults: { ...defaults, liveBookingCount, hasMainProgramme: liveBookingCount > 0 }, options: null },
  });
}

/** The last plan the form emitted. */
function lastPlan(wrapper: ReturnType<typeof mountForm>): BookingPlan | null | undefined {
  const emitted = wrapper.emitted("update:plan");
  return emitted ? (emitted[emitted.length - 1][0] as BookingPlan | null) : undefined;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("BookingPlanForm", () => {
  it("asks 'What is this venue for?' with the design's hint, placeholder and headcount prompt for a later venue", () => {
    const wrapper = mountForm(1);

    expect(wrapper.text()).toContain("What is this venue for?");
    expect(wrapper.text()).toContain("Another venue for part of the event. Size it for its own session.");
    expect(wrapper.get("input").attributes("placeholder")).toBe("1 to 300");
    expect(wrapper.text()).toContain("Enter a headcount to see venues for this booking.");
  });

  it("AC6: the first booking defaults to the main programme for the whole attendance", () => {
    const wrapper = mountForm(0);
    expect(lastPlan(wrapper)).toEqual({
      purpose: "Main programme",
      headcount: 300,
      layouts: ["Banquet"],
      facilities: ["PA system"],
      accessibility: [],
    });
  });

  it("the main programme has no purpose to pick; later bookings pick a session purpose", () => {
    expect(mountForm(0).findAll(".chips button[aria-pressed]").length).toBe(0);
    expect(mountForm(0).text()).toContain("Main programme");
    const later = mountForm(1).findAll("[role='group'] button").map((b) => b.text());
    expect(later).toEqual(["Breakout", "Registration", "Catering", "Other"]);
  });

  it("a later booking starts with no headcount, so no plan until one is entered", async () => {
    vi.useFakeTimers();
    const wrapper = mountForm(1);
    expect(lastPlan(wrapper)).toBeNull();

    await wrapper.find("input[inputmode='numeric']").setValue("40");
    vi.advanceTimersByTime(500);
    expect(lastPlan(wrapper)).toMatchObject({ purpose: "Breakout", headcount: 40 });
  });

  it("AC1: a headcount above the event's attendance gives no plan and says why", async () => {
    vi.useFakeTimers();
    const wrapper = mountForm(1);
    const input = wrapper.find("input[inputmode='numeric']");
    await input.setValue("301");
    await input.trigger("blur");
    vi.advanceTimersByTime(500);

    expect(lastPlan(wrapper)).toBeNull();
    expect(wrapper.text()).toContain("Can't be more than the event's 300 expected.");
  });
});

describe("plan in the search page's query (AC5)", () => {
  it("survives the round trip, including a group with nothing needed", () => {
    const plan: BookingPlan = {
      purpose: "Breakout",
      headcount: 40,
      layouts: ["Classroom"],
      facilities: ["Projector", "Whiteboard"],
      accessibility: [],
    };
    expect(planFromQuery(planRouteQuery(plan))).toEqual({ ...plan, purposeDetail: undefined });
  });

  it("is ignored without a valid headcount", () => {
    expect(planFromQuery({ purpose: "Breakout" })).toBeNull();
  });
});

describe("VenueRequestsPanel suitability", () => {
  const booking = (id: number, name: string): EventVenueBooking => ({
    id,
    status: "Requested",
    holdExpiresAt: null,
    decisionReason: null,
    createdAt: "2026-10-15T02:00:00.000Z",
    venue: { id, name, location: "Central Campus" },
  });

  const suitability = (bookingId: number, overrides: Partial<BookingSuitability>): BookingSuitability => ({
    bookingId,
    status: "Requested",
    purpose: "Main programme",
    purposeDetail: null,
    headcount: 300,
    requirements: { layouts: [], facilities: [], accessibility: [] },
    suitability: { suitable: true, reasons: [] },
    ...overrides,
  });

  it("AC2: shows one booking unsuitable without affecting the others", () => {
    const wrapper = mount(VenueRequestsPanel, {
      props: {
        bookings: [booking(1, "Grand Ballroom"), booking(2, "Seminar Room 3-01")],
        loading: false,
        loadError: null,
        suitability: [
          suitability(1, {}),
          suitability(2, {
            purpose: "Breakout",
            headcount: 60,
            suitability: {
              suitable: false,
              reasons: [
                { kind: "capacity", capacity: 40, headcount: 60 },
                { kind: "facilities", missing: ["Whiteboard"] },
              ],
            },
          }),
        ],
      },
    });

    const rows = wrapper.findAll(".request-row");
    expect(rows[0].text()).toContain("Main programme, 300 people");
    // A suitable venue gets no extra line; only a mismatch is called out.
    expect(rows[0].text()).not.toContain("Suitable for this booking");
    expect(rows[0].find(".suitability").exists()).toBe(false);
    expect(rows[1].text()).toContain("Breakout, 60 people");
    expect(rows[1].text()).toContain("Unsuitable: holds 40, needs 60; no Whiteboard");
  });

  it("shows nothing extra when no suitability is passed (E4-8 unchanged)", () => {
    const wrapper = mount(VenueRequestsPanel, {
      props: { bookings: [booking(1, "Grand Ballroom")], loading: false, loadError: null },
    });
    expect(wrapper.text()).not.toContain("Suitable");
  });
});
