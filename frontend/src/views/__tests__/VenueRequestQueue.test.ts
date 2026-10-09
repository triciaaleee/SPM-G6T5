import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import VenueRequestQueue from "../VenueRequestQueue.vue";
import {
  BookingConflictError,
  approveBooking,
  fetchPendingRequests,
  holdBooking,
  rejectBooking,
  type PendingVenueRequest,
} from "../../lib/venuesApi";

vi.mock("../../lib/venuesApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/venuesApi")>("../../lib/venuesApi");
  return {
    BookingConflictError: actual.BookingConflictError,
    describeBookingFailure: actual.describeBookingFailure,
    fetchPendingRequests: vi.fn(),
    holdBooking: vi.fn(),
    approveBooking: vi.fn(),
    rejectBooking: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchPendingRequests);
const mockedHold = vi.mocked(holdBooking);
const mockedApprove = vi.mocked(approveBooking);
const mockedReject = vi.mocked(rejectBooking);

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/venue-requests", name: "venue-requests", component: { render: () => h("div") } },
    { path: "/venue-schedule", name: "venue-schedule", component: { render: () => h("div") } },
  ],
});

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

async function mountQueue(requests: PendingVenueRequest[]) {
  mockedFetch.mockResolvedValue(requests);
  const wrapper = mount(VenueRequestQueue, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VenueRequestQueue", () => {
  it("AC6: shows requests in the order the server returned, soonest first", async () => {
    const wrapper = await mountQueue([
      makeRequest({ id: 11, event: { ...makeRequest().event, id: 21, name: "Robotics Demo", date: "2026-11-02" } }),
      makeRequest(),
    ]);

    const titles = wrapper.findAll(".card-title").map((node) => node.text());
    expect(titles).toEqual(["Robotics Demo", "Alumni Dinner"]);
  });

  it("AC1/AC6: shows the venue's setup and turnaround alongside the event's own times", async () => {
    const wrapper = await mountQueue([makeRequest()]);
    expect(wrapper.text()).toContain("10:00–12:00");
    expect(wrapper.text()).toContain("30 min setup, 45 min turnaround");
  });

  it("AC1: holds a request, then reloads because a hold can knock others out", async () => {
    mockedHold.mockResolvedValue(decided());
    const wrapper = await mountQueue([makeRequest()]);

    await wrapper.findAll("button").find((b) => b.text() === "Hold")!.trigger("click");
    await flushPromises();

    expect(mockedHold).toHaveBeenCalledWith(10);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("offers no Hold on a booking that is already On Hold", async () => {
    const wrapper = await mountQueue([makeRequest({ status: "On Hold", holdExpiresAt: "2026-11-01T00:00:00.000Z" })]);

    expect(wrapper.findAll("button").map((b) => b.text())).not.toContain("Hold");
    expect(wrapper.text()).toContain("Hold expires");
  });

  it("E4-11 AC4: says how many overlapping requests the approval knocked out", async () => {
    mockedApprove.mockResolvedValue(decided([11, 12]));
    const wrapper = await mountQueue([makeRequest()]);

    await wrapper.findAll("button").find((b) => b.text() === "Approve")!.trigger("click");
    await flushPromises();

    expect(wrapper.find(".notice").text()).toContain("2 overlapping requests were rejected automatically");
  });

  it("AC2: shows the clashing window when the action is refused", async () => {
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
    const wrapper = await mountQueue([makeRequest()]);

    await wrapper.findAll("button").find((b) => b.text() === "Approve")!.trigger("click");
    await flushPromises();

    const alert = wrapper.find('[role="alert"]');
    expect(alert.text()).toContain("2026-11-10 12:00–14:45");
    expect(alert.text()).toContain("2026-11-10 09:30–12:45");
  });

  it("AC4: refuses to reject without a reason", async () => {
    const wrapper = await mountQueue([makeRequest()]);

    await wrapper.findAll("button").find((b) => b.text() === "Reject")!.trigger("click");
    await wrapper.findAll("button").find((b) => b.text() === "Confirm rejection")!.trigger("click");
    await flushPromises();

    expect(mockedReject).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Give a reason for rejecting this request.");
  });

  it("AC4: sends the reason with the rejection", async () => {
    mockedReject.mockResolvedValue(decided());
    const wrapper = await mountQueue([makeRequest()]);

    await wrapper.findAll("button").find((b) => b.text() === "Reject")!.trigger("click");
    await wrapper.find("textarea").setValue("Floor resurfacing that week");
    await wrapper.findAll("button").find((b) => b.text() === "Confirm rejection")!.trigger("click");
    await flushPromises();

    expect(mockedReject).toHaveBeenCalledWith(10, "Floor resurfacing that week");
  });

  it("says so when nothing is waiting", async () => {
    const wrapper = await mountQueue([]);
    expect(wrapper.text()).toContain("Nothing is waiting on a decision right now.");
  });

  it("surfaces a load failure", async () => {
    mockedFetch.mockRejectedValue(new Error("Failed to load booking requests"));
    const wrapper = mount(VenueRequestQueue, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.find('[role="alert"]').text()).toBe("Failed to load booking requests");
  });
});
