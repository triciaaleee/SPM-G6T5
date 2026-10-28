import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SafetyReviewQueueView from "../SafetyReviewQueueView.vue";
import {
  approveSafetyReview,
  fetchSafetyReviewQueue,
  rejectSafetyReview,
  SafetyReviewRejectError,
  type EventSummary,
  type SafetyReviewQueueItem,
} from "../../../lib/eventsApi";

vi.mock("../../../lib/eventsApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/eventsApi")>("../../../lib/eventsApi");
  return {
    MAX_SAFETY_REJECT_REASON_LENGTH: actual.MAX_SAFETY_REJECT_REASON_LENGTH,
    SafetyReviewApproveError: actual.SafetyReviewApproveError,
    SafetyReviewRejectError: actual.SafetyReviewRejectError,
    fetchSafetyReviewQueue: vi.fn(),
    approveSafetyReview: vi.fn(),
    rejectSafetyReview: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchSafetyReviewQueue);
const mockedApprove = vi.mocked(approveSafetyReview);
const mockedReject = vi.mocked(rejectSafetyReview);

function makeEvent(overrides: Partial<SafetyReviewQueueItem> = {}): SafetyReviewQueueItem {
  return {
    id: 7,
    status: "Safety Review",
    submitted_details: { name: "Spring Gala", proposedDate: "2026-11-10", startTime: "18:00", endTime: "22:00", expectedAttendance: 200 },
    coordinator_id: "COORD-0001",
    coordinator: { name: "Casey Coordinator" },
    created_at: "2026-10-01T00:00:00Z",
    safetyNotes: {
      equipmentPlacement: "Speakers at the back",
      crowdMovement: "Two entrances",
      emergencyAccess: "East exit kept clear",
      venueRestrictions: "None known",
    },
    ...overrides,
  } as SafetyReviewQueueItem;
}

async function mountQueue(events: SafetyReviewQueueItem[]) {
  mockedFetch.mockResolvedValue(events);
  const wrapper = mount(SafetyReviewQueueView);
  await flushPromises();
  return wrapper;
}

function button(wrapper: Awaited<ReturnType<typeof mountQueue>>, text: string) {
  return wrapper.findAll("button").find((b) => b.text() === text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SafetyReviewQueueView", () => {
  it("E1-10: shows each event with the coordinator's safety notes", async () => {
    const wrapper = await mountQueue([makeEvent()]);

    expect(wrapper.find(".card-title").text()).toBe("Spring Gala");
    expect(wrapper.text()).toContain("Casey Coordinator");
    expect(wrapper.text()).toContain("East exit kept clear");
  });

  it("E3-12: approves an event and reloads the queue", async () => {
    mockedApprove.mockResolvedValue({} as EventSummary);
    const wrapper = await mountQueue([makeEvent()]);

    await button(wrapper, "Approve")!.trigger("click");
    await flushPromises();

    expect(mockedApprove).toHaveBeenCalledWith(7);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(wrapper.find(".notice").text()).toContain("now Confirmed");
  });

  it("E3-13: Reject opens a reason box instead of rejecting straight away", async () => {
    const wrapper = await mountQueue([makeEvent()]);

    await button(wrapper, "Reject")!.trigger("click");

    expect(wrapper.find("textarea").exists()).toBe(true);
    expect(button(wrapper, "Approve")).toBeUndefined();
    expect(mockedReject).not.toHaveBeenCalled();
  });

  it("E3-13 AC2: refuses to reject without a reason", async () => {
    const wrapper = await mountQueue([makeEvent()]);

    await button(wrapper, "Reject")!.trigger("click");
    await wrapper.find("textarea").setValue("   ");
    await button(wrapper, "Confirm rejection")!.trigger("click");
    await flushPromises();

    expect(mockedReject).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Give a reason for rejecting this safety review.");
  });

  it("E3-13 AC1: sends the trimmed reason, says the event is back in Planning and reloads", async () => {
    mockedReject.mockResolvedValue({} as EventSummary);
    const wrapper = await mountQueue([makeEvent()]);

    await button(wrapper, "Reject")!.trigger("click");
    await wrapper.find("textarea").setValue("  Fire exit blocked by staging  ");
    await button(wrapper, "Confirm rejection")!.trigger("click");
    await flushPromises();

    expect(mockedReject).toHaveBeenCalledWith(7, "Fire exit blocked by staging");
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(wrapper.find(".notice").text()).toContain("back in Planning");
    expect(wrapper.find("textarea").exists()).toBe(false);
  });

  it("caps the reason at the backend's limit", async () => {
    const wrapper = await mountQueue([makeEvent()]);

    await button(wrapper, "Reject")!.trigger("click");

    expect(wrapper.find("textarea").attributes("maxlength")).toBe("2000");
  });

  it("Cancel closes the reason box without rejecting", async () => {
    const wrapper = await mountQueue([makeEvent()]);

    await button(wrapper, "Reject")!.trigger("click");
    await wrapper.find("textarea").setValue("Not sure yet");
    await button(wrapper, "Cancel")!.trigger("click");

    expect(wrapper.find("textarea").exists()).toBe(false);
    expect(button(wrapper, "Approve")).toBeDefined();
    expect(mockedReject).not.toHaveBeenCalled();
  });

  it("shows the server's message when a rejection is refused, and keeps the reason box open", async () => {
    mockedReject.mockRejectedValue(new SafetyReviewRejectError("This event is no longer in Safety Review"));
    const wrapper = await mountQueue([makeEvent()]);

    await button(wrapper, "Reject")!.trigger("click");
    await wrapper.find("textarea").setValue("Crowd plan missing");
    await button(wrapper, "Confirm rejection")!.trigger("click");
    await flushPromises();

    expect(wrapper.find('[role="alert"]').text()).toBe("This event is no longer in Safety Review");
    expect(wrapper.find("textarea").exists()).toBe(true);
  });

  it("says so when nothing is waiting", async () => {
    const wrapper = await mountQueue([]);
    expect(wrapper.text()).toContain("No events are awaiting a safety review.");
  });
});
