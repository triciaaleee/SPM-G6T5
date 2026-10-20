import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import VenueRequestsPanel from "../VenueRequestsPanel.vue";
import * as venuesApi from "../../../lib/venuesApi";
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
  props: Partial<{
    bookings: EventVenueBooking[] | undefined;
    loading: boolean;
    loadError: string | null;
    canWithdraw: boolean;
  }> = {},
) {
  return mount(VenueRequestsPanel, {
    props: { bookings: [], loading: false, loadError: null, ...props },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("offers Find replacement on a Replacement Required booking, linking to venue search", () => {
    const wrapper = mount(VenueRequestsPanel, {
      props: {
        bookings: [makeBooking({ status: "Replacement Required" })],
        loading: false,
        loadError: null,
        canWithdraw: true,
        findReplacementTo: { name: "venue-search", query: { eventId: "7" } },
      },
      global: { stubs: { RouterLink: { props: ["to"], template: '<a class="stub-link" :data-to="JSON.stringify(to)"><slot /></a>' } } },
    });

    const link = wrapper.find(".stub-link");
    expect(link.exists()).toBe(true);
    expect(link.text()).toBe("Find replacement");
    expect(JSON.parse(link.attributes("data-to")!)).toEqual({ name: "venue-search", query: { eventId: "7" } });
  });

  it("hides Find replacement for other statuses and for non-coordinators", () => {
    const approved = mount(VenueRequestsPanel, {
      props: { bookings: [makeBooking({ status: "Approved" })], loading: false, loadError: null, canWithdraw: true, findReplacementTo: { name: "venue-search" } },
      global: { stubs: { RouterLink: true } },
    });
    expect(approved.text()).not.toContain("Find replacement");

    const readOnly = mountPanel({ bookings: [makeBooking({ status: "Replacement Required" })] });
    expect(readOnly.text()).not.toContain("Find replacement");
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

  describe("E4-9: withdraw and release", () => {
    it("hides the action when canWithdraw is false", () => {
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Requested" })], canWithdraw: false });
      expect(wrapper.find(".action-btn").exists()).toBe(false);
    });

    it.each([
      ["Requested", "Withdraw"],
      ["On Hold", "Withdraw"],
      ["Approved", "Release"],
      ["Replacement Required", "Release"],
    ] as const)("shows %s", async (status, label) => {
      const wrapper = mountPanel({ bookings: [makeBooking({ status })], canWithdraw: true });
      expect(wrapper.find(".action-btn").text()).toBe(label);
    });

    it.each(["Rejected", "Expired", "Withdrawn"] as const)(
      "offers no action for a %s booking",
      (status) => {
        const wrapper = mountPanel({ bookings: [makeBooking({ status })], canWithdraw: true });
        expect(wrapper.find(".action-btn").exists()).toBe(false);
      },
    );

    it("opens an in-page confirm dialog instead of the browser's native confirm()", async () => {
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Requested" })], canWithdraw: true });

      expect(wrapper.find(".modal-overlay").exists()).toBe(false);
      await wrapper.find(".action-btn").trigger("click");

      expect(wrapper.find(".modal-overlay").exists()).toBe(true);
      expect(wrapper.find(".modal-title").text()).toBe("Withdraw this request?");
    });

    it("shows the release wording for an Approved booking's dialog", async () => {
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Approved" })], canWithdraw: true });
      await wrapper.find(".action-btn").trigger("click");

      expect(wrapper.find(".modal-title").text()).toBe("Release this booking?");
    });

    it("E4-15 AC3: shows replacement-specific wording for a Replacement Required booking's dialog", async () => {
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Replacement Required" })], canWithdraw: true });
      await wrapper.find(".action-btn").trigger("click");

      expect(wrapper.find(".modal-title").text()).toBe("Release this booking?");
      expect(wrapper.text()).toContain("no longer available");
    });

    it("closes the dialog without acting when Cancel is clicked", async () => {
      const withdraw = vi.spyOn(venuesApi, "withdrawVenueBooking");
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Requested" })], canWithdraw: true });
      await wrapper.find(".action-btn").trigger("click");

      await wrapper.find(".modal-actions .btn--outline").trigger("click");

      expect(wrapper.find(".modal-overlay").exists()).toBe(false);
      expect(withdraw).not.toHaveBeenCalled();
    });

    it("AC1: withdraws once confirmed in the dialog and tells the page to refresh", async () => {
      const withdraw = vi
        .spyOn(venuesApi, "withdrawVenueBooking")
        .mockResolvedValue({ booking: { id: 900, status: "Withdrawn", venue: null as never }, staffNotified: true });
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Requested" })], canWithdraw: true });
      await wrapper.find(".action-btn").trigger("click");

      await wrapper.find(".modal-actions .btn--danger-solid").trigger("click");
      await Promise.resolve();
      await Promise.resolve();

      expect(withdraw).toHaveBeenCalledWith(900);
      expect(wrapper.emitted("changed")).toHaveLength(1);
      expect(wrapper.find(".modal-overlay").exists()).toBe(false);
    });

    it("AC2: releases an Approved booking once confirmed", async () => {
      const release = vi
        .spyOn(venuesApi, "releaseVenueBooking")
        .mockResolvedValue({ booking: { id: 900, status: "Withdrawn", venue: null as never }, staffNotified: true });
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Approved" })], canWithdraw: true });
      await wrapper.find(".action-btn").trigger("click");

      await wrapper.find(".modal-actions .btn--danger-solid").trigger("click");
      await Promise.resolve();
      await Promise.resolve();

      expect(release).toHaveBeenCalledWith(900);
      expect(wrapper.emitted("changed")).toHaveLength(1);
    });

    it("E4-15 AC3: releases a Replacement Required booking once confirmed", async () => {
      const release = vi
        .spyOn(venuesApi, "releaseVenueBooking")
        .mockResolvedValue({ booking: { id: 900, status: "Withdrawn", venue: null as never }, staffNotified: true });
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Replacement Required" })], canWithdraw: true });
      await wrapper.find(".action-btn").trigger("click");

      await wrapper.find(".modal-actions .btn--danger-solid").trigger("click");
      await Promise.resolve();
      await Promise.resolve();

      expect(release).toHaveBeenCalledWith(900);
      expect(wrapper.emitted("changed")).toHaveLength(1);
    });

    it("AC2: shows the server's blocked message and doesn't emit changed", async () => {
      vi.spyOn(venuesApi, "withdrawVenueBooking").mockRejectedValue(
        new venuesApi.BookingRequestError("This booking is already Approved — release it instead."),
      );
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Requested" })], canWithdraw: true });
      await wrapper.find(".action-btn").trigger("click");

      await wrapper.find(".modal-actions .btn--danger-solid").trigger("click");
      await Promise.resolve();
      await Promise.resolve();

      expect(wrapper.text()).toContain("This booking is already Approved — release it instead.");
      expect(wrapper.emitted("changed")).toBeUndefined();
      expect(wrapper.find(".modal-overlay").exists()).toBe(false);
    });
  });
});
