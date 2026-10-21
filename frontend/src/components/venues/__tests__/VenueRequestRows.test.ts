import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VenueRequestRows from "../VenueRequestRows.vue";
import {
  BookingConflictError,
  approveBooking,
  holdBooking,
  rejectBooking,
  type PendingVenueRequest,
} from "../../../lib/venuesApi";

vi.mock("../../../lib/venuesApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/venuesApi")>("../../../lib/venuesApi");
  return {
    BookingConflictError: actual.BookingConflictError,
    describeBookingFailure: actual.describeBookingFailure,
    holdBooking: vi.fn(),
    approveBooking: vi.fn(),
    rejectBooking: vi.fn(),
  };
});

const mockedHold = vi.mocked(holdBooking);
const mockedApprove = vi.mocked(approveBooking);
const mockedReject = vi.mocked(rejectBooking);

function makeRequest(overrides: Partial<PendingVenueRequest> = {}): PendingVenueRequest {
  return {
    id: 10,
    status: "Requested",
    holdExpiresAt: null,
    venue: { id: 1, name: "Grand Ballroom", location: "Central Campus", setupMinutes: 30, turnaroundMinutes: 45 },
    event: {
      id: 7,
      name: "Alumni Dinner",
      date: "2026-11-10",
      startTime: "10:00",
      endTime: "12:00",
      expectedAttendance: 120,
      layouts: ["Banquet"],
      facilities: ["PA system"],
    },
    ...overrides,
  };
}

function decided(autoRejectedBookingIds: number[] = []) {
  return {
    booking: {
      id: 10,
      status: "Approved" as const,
      holdExpiresAt: null,
      decisionReason: null,
      decidedAt: "2026-10-08T00:00:00.000Z",
      venue: { id: 1, name: "Grand Ballroom", location: "Central Campus" },
    },
    autoRejectedBookingIds,
  };
}

const button = (wrapper: ReturnType<typeof mount>, label: string) =>
  wrapper.findAll("button").find((b) => b.text() === label)!;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VenueRequestRows", () => {
  it("AC7: shows requests in the order it is given", () => {
    const wrapper = mount(VenueRequestRows, {
      props: {
        requests: [
          makeRequest({ id: 11, event: { ...makeRequest().event, id: 21, name: "Robotics Demo", date: "2026-11-02" } }),
          makeRequest(),
        ],
      },
    });

    expect(wrapper.findAll(".row__name").map((node) => node.text())).toEqual(["Robotics Demo", "Alumni Dinner"]);
  });

  it("shows the venue's setup and turnaround alongside the event's own times", () => {
    const wrapper = mount(VenueRequestRows, { props: { requests: [makeRequest()] } });

    expect(wrapper.text()).toContain("10:00–12:00");
    expect(wrapper.text()).toContain("30 min setup, 45 min turnaround");
  });

  it("AC1: holds a request and tells the page, because a hold can knock others out", async () => {
    mockedHold.mockResolvedValue(decided());
    const wrapper = mount(VenueRequestRows, { props: { requests: [makeRequest()] } });

    await button(wrapper, "Hold").trigger("click");
    await flushPromises();

    expect(mockedHold).toHaveBeenCalledWith(10);
    expect(wrapper.emitted("decided")![0][0]).toContain("Grand Ballroom is on hold for Alumni Dinner");
  });

  it("offers no Hold on a booking that is already On Hold", () => {
    const wrapper = mount(VenueRequestRows, {
      props: { requests: [makeRequest({ status: "On Hold", holdExpiresAt: "2026-11-01T00:00:00.000Z" })] },
    });

    expect(wrapper.findAll("button").map((b) => b.text())).not.toContain("Hold");
    expect(wrapper.text()).toContain("Hold expires");
  });

  it("E4-11 AC4: says how many overlapping requests the approval knocked out", async () => {
    mockedApprove.mockResolvedValue(decided([11, 12]));
    const wrapper = mount(VenueRequestRows, { props: { requests: [makeRequest()] } });

    await button(wrapper, "Approve").trigger("click");
    await flushPromises();

    expect(wrapper.emitted("decided")![0][0]).toContain("2 overlapping requests were rejected automatically");
  });

  it("AC2/AC3: shows the clashing window when the action is refused, and does not report a decision", async () => {
    mockedApprove.mockRejectedValue(
      new BookingConflictError("Venue is not available for this period", {
        bookingId: 99,
        status: "Approved",
        window: "2026-11-10 12:00–14:45",
        requestedWindow: "2026-11-10 09:30–12:45",
        setupMinutes: 30,
        turnaroundMinutes: 45,
      }),
    );
    const wrapper = mount(VenueRequestRows, { props: { requests: [makeRequest()] } });

    await button(wrapper, "Approve").trigger("click");
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.text()).toContain("2026-11-10 12:00–14:45");
    expect(alert.text()).toContain("2026-11-10 09:30–12:45");
    expect(wrapper.emitted("decided")).toBeUndefined();
  });

  it("AC5: refuses to reject without a reason", async () => {
    const wrapper = mount(VenueRequestRows, { props: { requests: [makeRequest()] } });

    await button(wrapper, "Reject").trigger("click");
    await button(wrapper, "Confirm rejection").trigger("click");
    await flushPromises();

    expect(mockedReject).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Give a reason for rejecting this request.");
  });

  it("AC5: sends the reason with the rejection", async () => {
    mockedReject.mockResolvedValue(decided());
    const wrapper = mount(VenueRequestRows, { props: { requests: [makeRequest()] } });

    await button(wrapper, "Reject").trigger("click");
    await wrapper.find("textarea").setValue("Floor resurfacing that week");
    await button(wrapper, "Confirm rejection").trigger("click");
    await flushPromises();

    expect(mockedReject).toHaveBeenCalledWith(10, "Floor resurfacing that week");
    expect(wrapper.emitted("decided")![0][0]).toContain("was rejected");
  });

  it("opens the layout and facility details on request", async () => {
    const wrapper = mount(VenueRequestRows, { props: { requests: [makeRequest()] } });
    expect(wrapper.text()).not.toContain("Banquet");

    await button(wrapper, "Details").trigger("click");

    expect(wrapper.text()).toContain("Banquet");
    expect(wrapper.text()).toContain("PA system");
  });
});
