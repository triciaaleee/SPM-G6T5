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
  slots: Record<string, string> = {},
) {
  return mount(VenueRequestsPanel, {
    props: { bookings: [], loading: false, loadError: null, ...props },
    slots,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

type Wrapper = ReturnType<typeof mountPanel>;

/** Opens the row's ··· menu. */
async function openMenu(wrapper: Wrapper) {
  await wrapper.find(".menu-trigger").trigger("click");
}

/** Opens the ··· menu and chooses its item (Release venue / Withdraw request). */
async function openAction(wrapper: Wrapper) {
  await openMenu(wrapper);
  await wrapper.find(".menu-item").trigger("click");
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

  describe("E4-9: withdraw and release", () => {
    it("hides the action when canWithdraw is false", () => {
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Requested" })], canWithdraw: false });
      expect(wrapper.find(".menu-trigger").exists()).toBe(false);
    });

    it.each([
      ["Requested", "Withdraw request"],
      ["On Hold", "Withdraw request"],
      ["Approved", "Release venue"],
      ["Replacement Required", "Release venue"],
    ] as const)("shows %s", async (status, label) => {
      const wrapper = mountPanel({ bookings: [makeBooking({ status })], canWithdraw: true });
      // The action sits behind a ··· button until it is opened.
      expect(wrapper.find(".menu-item").exists()).toBe(false);
      await openMenu(wrapper);
      expect(wrapper.find(".menu-item").text()).toBe(label);
    });

    it.each(["Rejected", "Expired", "Withdrawn"] as const)(
      "offers no action for a %s booking",
      (status) => {
        const wrapper = mountPanel({ bookings: [makeBooking({ status })], canWithdraw: true });
        expect(wrapper.find(".menu-trigger").exists()).toBe(false);
      },
    );

    it("opens an in-page confirm dialog instead of the browser's native confirm()", async () => {
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Requested" })], canWithdraw: true });

      expect(wrapper.find(".modal-overlay").exists()).toBe(false);
      await openAction(wrapper);

      expect(wrapper.find(".modal-overlay").exists()).toBe(true);
      expect(wrapper.find(".modal-title").text()).toBe("Withdraw this request?");
    });

    it("shows the release wording for an Approved booking's dialog", async () => {
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Approved" })], canWithdraw: true });
      await openAction(wrapper);

      expect(wrapper.find(".modal-title").text()).toBe("Release this booking?");
    });

    it("E4-15 AC3: shows replacement-specific wording for a Replacement Required booking's dialog", async () => {
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Replacement Required" })], canWithdraw: true });
      await openAction(wrapper);

      expect(wrapper.find(".modal-title").text()).toBe("Release this booking?");
      expect(wrapper.text()).toContain("no longer available");
    });

    it("closes the dialog without acting when Cancel is clicked", async () => {
      const withdraw = vi.spyOn(venuesApi, "withdrawVenueBooking");
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Requested" })], canWithdraw: true });
      await openAction(wrapper);

      await wrapper.find(".modal-actions .btn--outline").trigger("click");

      expect(wrapper.find(".modal-overlay").exists()).toBe(false);
      expect(withdraw).not.toHaveBeenCalled();
    });

    it("AC1: withdraws once confirmed in the dialog and tells the page to refresh", async () => {
      const withdraw = vi
        .spyOn(venuesApi, "withdrawVenueBooking")
        .mockResolvedValue({ booking: { id: 900, status: "Withdrawn", venue: null as never }, staffNotified: true });
      const wrapper = mountPanel({ bookings: [makeBooking({ status: "Requested" })], canWithdraw: true });
      await openAction(wrapper);

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
      await openAction(wrapper);

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
      await openAction(wrapper);

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
      await openAction(wrapper);

      await wrapper.find(".modal-actions .btn--danger-solid").trigger("click");
      await Promise.resolve();
      await Promise.resolve();

      expect(wrapper.text()).toContain("This booking is already Approved — release it instead.");
      expect(wrapper.emitted("changed")).toBeUndefined();
      expect(wrapper.find(".modal-overlay").exists()).toBe(false);
    });
  });
});

describe("VenueRequestsPanel — actions slot", () => {
  const slots = { actions: '<button data-testid="slotted">Request another venue</button>' };

  it("renders under the request list once the requests have loaded", () => {
    const wrapper = mountPanel({ bookings: [makeBooking()] }, slots);

    const button = wrapper.get('[data-testid="slotted"]');
    expect(button.text()).toBe("Request another venue");
    expect(
      wrapper.get(".request-list").element.compareDocumentPosition(button.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("also renders when there are no requests yet", () => {
    expect(mountPanel({ bookings: [] }, slots).find('[data-testid="slotted"]').exists()).toBe(true);
  });

  it("is left out while the requests are loading or failed to load", () => {
    expect(mountPanel({ bookings: undefined }, slots).find('[data-testid="slotted"]').exists()).toBe(false);
    expect(mountPanel({ loading: true, bookings: [] }, slots).find('[data-testid="slotted"]').exists()).toBe(false);
    expect(mountPanel({ loadError: "Failed" }, slots).find('[data-testid="slotted"]').exists()).toBe(false);
  });
});

describe("VenueRequestsPanel — row design", () => {
  const approved = () =>
    makeBooking({
      status: "Approved",
      createdAt: new Date(2026, 9, 19, 22, 26).toISOString(),
      venue: { id: 2, name: "Seminar Room 3-01", location: "North Campus" },
    });
  const suitability = [
    {
      bookingId: 900,
      purpose: "Main programme",
      purposeDetail: null,
      headcount: 20,
      requirements: { layouts: [], facilities: [], accessibility: [] },
      suitability: { suitable: true, reasons: [] },
    },
  ] as never;

  it("lists location, then name, then purpose, then the requested time", () => {
    const row = mountPanel({ bookings: [approved()], suitability }).get(".request-row");

    const parts = ["North Campus", "Seminar Room 3-01", "Main programme, 20 people", "Requested 19 Oct 2026, 10:26 PM"];
    const classes = [".request-location", ".request-name", ".request-purpose", ".request-requested"];
    classes.forEach((selector, index) => expect(row.get(selector).text()).toBe(parts[index]));
    for (let i = 1; i < classes.length; i++) {
      expect(
        row.get(classes[i - 1]).element.compareDocumentPosition(row.get(classes[i]).element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it("says '1 person' for a headcount of one", () => {
    const one = [{ ...(suitability as never[])[0], headcount: 1 }] as never;
    expect(mountPanel({ bookings: [approved()], suitability: one }).get(".request-purpose").text()).toBe(
      "Main programme, 1 person",
    );
  });

  it("puts a check icon in the Approved badge only", () => {
    const wrapper = mountPanel({ bookings: [approved(), makeBooking({ id: 901, status: "Requested" })] });
    const badges = wrapper.findAll(".badge");
    expect(badges[0].find(".badge__icon").exists()).toBe(true);
    expect(badges[0].text()).toBe("Approved");
    expect(badges[1].find(".badge__icon").exists()).toBe(false);
  });

  it("calls out an unsuitable venue but not a suitable one", () => {
    const bad = [
      {
        ...(suitability as never[])[0],
        suitability: { suitable: false, reasons: [{ kind: "capacity", capacity: 10, headcount: 20 }] },
      },
    ] as never;
    expect(mountPanel({ bookings: [approved()], suitability }).find(".suitability").exists()).toBe(false);
    expect(mountPanel({ bookings: [approved()], suitability: bad }).get(".suitability").text()).toContain("Unsuitable");
  });
});

describe("VenueRequestsPanel — ··· menu", () => {
  it("labels the trigger with the venue, and reflects whether it is open", async () => {
    const wrapper = mountPanel({ bookings: [makeBooking({ status: "Approved" })], canWithdraw: true });
    const trigger = wrapper.get(".menu-trigger");

    expect(trigger.attributes("aria-label")).toBe("More actions for Grand Ballroom");
    expect(trigger.attributes("aria-haspopup")).toBe("menu");
    expect(trigger.attributes("aria-expanded")).toBe("false");

    await trigger.trigger("click");
    expect(wrapper.get(".menu-trigger").attributes("aria-expanded")).toBe("true");
    expect(wrapper.get(".menu").attributes("role")).toBe("menu");
    expect(wrapper.get(".menu-item").attributes("role")).toBe("menuitem");

    await wrapper.get(".menu-trigger").trigger("click");
    expect(wrapper.find(".menu").exists()).toBe(false);
  });

  it("closes on Escape and on a click outside the menu", async () => {
    // Attached to the document so the panel's document-level listeners see the events.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const attached = mount(VenueRequestsPanel, {
      attachTo: host,
      props: { bookings: [makeBooking({ status: "Approved" })], loading: false, loadError: null, canWithdraw: true },
    });

    await attached.get(".menu-trigger").trigger("click");
    expect(attached.find(".menu").exists()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await attached.vm.$nextTick();
    expect(attached.find(".menu").exists()).toBe(false);

    await attached.get(".menu-trigger").trigger("click");
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await attached.vm.$nextTick();
    expect(attached.find(".menu").exists()).toBe(false);

    attached.unmount();
    host.remove();
  });

  it("keeps one menu open at a time", async () => {
    const wrapper = mountPanel({
      bookings: [makeBooking({ id: 1, status: "Approved" }), makeBooking({ id: 2, status: "Requested" })],
      canWithdraw: true,
    });
    const [first, second] = wrapper.findAll(".menu-trigger");

    await first.trigger("click");
    await second.trigger("click");

    expect(wrapper.findAll(".menu")).toHaveLength(1);
    expect(wrapper.get(".menu-item").text()).toBe("Withdraw request");
  });

  it("closes the menu when its item is chosen, leaving the confirm dialog open", async () => {
    const wrapper = mountPanel({ bookings: [makeBooking({ status: "Approved" })], canWithdraw: true });
    await openAction(wrapper);

    expect(wrapper.find(".menu").exists()).toBe(false);
    expect(wrapper.find(".modal-overlay").exists()).toBe(true);
  });
});
