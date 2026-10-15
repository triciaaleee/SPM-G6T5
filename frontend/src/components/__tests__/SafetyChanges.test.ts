import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SafetyChangesCard from "../SafetyChangesCard.vue";
import SafetyReviewQueueView from "../../views/SafetyReviewQueueView.vue";
import type { SafetyChangeRequest, SafetyReviewQueueItem } from "../../lib/eventsApi";

/** E3-14: the Safety Officer requests changes; the coordinator sees what's flagged. */

const fetchSafetyReviewQueue = vi.fn();
const requestSafetyChanges = vi.fn();

vi.mock("../../lib/eventsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/eventsApi")>();
  return {
    ...actual,
    fetchSafetyReviewQueue: (...args: unknown[]) => fetchSafetyReviewQueue(...args),
    requestSafetyChanges: (...args: unknown[]) => requestSafetyChanges(...args),
  };
});

const queueItem = {
  id: 7,
  status: "Safety Review",
  submitted_details: { name: "Spring Gala", proposedDate: "2026-11-10", startTime: "10:00", endTime: "12:00" },
  coordinator: { name: "Casey Lim" },
  safetyNotes: null,
  arrangements: [
    { type: "venue_booking", id: 32, label: "Seminar Room 3-01", detail: "Approved" },
    { type: "equipment_item", id: 51, label: "PA system × 2", detail: "2 of 2 reserved" },
  ],
  changeRequest: null,
} as unknown as SafetyReviewQueueItem;

async function openRequestChanges() {
  fetchSafetyReviewQueue.mockResolvedValue([queueItem]);
  const wrapper = mount(SafetyReviewQueueView);
  await flushPromises();
  const button = wrapper.findAll("button").find((b) => b.text() === "Request changes")!;
  await button.trigger("click");
  return wrapper;
}

type Wrapper = Awaited<ReturnType<typeof openRequestChanges>>;

function sendButton(wrapper: Wrapper) {
  return wrapper.findAll("button").find((b) => b.text() === "Send to coordinator")!;
}

function noteBox(wrapper: Wrapper, label: string) {
  return wrapper.get(`textarea[aria-label="What must change: ${label}"]`);
}

beforeEach(() => {
  fetchSafetyReviewQueue.mockReset();
  requestSafetyChanges.mockReset();
});

describe("Safety Officer: Request changes", () => {
  it("lists the event's venue bookings and equipment to pick from", async () => {
    const wrapper = await openRequestChanges();
    expect(wrapper.text()).toContain("Seminar Room 3-01");
    expect(wrapper.text()).toContain("PA system × 2");
    expect(wrapper.findAll("input[type='checkbox']")).toHaveLength(2);
  });

  it("gives each ticked arrangement its own note box", async () => {
    const wrapper = await openRequestChanges();
    expect(wrapper.find('textarea[aria-label^="What must change"]').exists()).toBe(false);

    await wrapper.findAll("input[type='checkbox']")[0].setValue(true);
    expect(noteBox(wrapper, "Seminar Room 3-01").element).toBeTruthy();
    expect(wrapper.find('textarea[aria-label="What must change: PA system × 2"]').exists()).toBe(false);
  });

  it("AC2: blocks sending with no arrangement picked", async () => {
    const wrapper = await openRequestChanges();
    await wrapper.get("textarea").setValue("Update the crowd plan.");
    await sendButton(wrapper).trigger("click");

    expect(wrapper.text()).toContain("Select at least one venue booking or equipment reservation that must change.");
    expect(requestSafetyChanges).not.toHaveBeenCalled();
  });

  it("AC2: blocks sending when a ticked arrangement has no note", async () => {
    const wrapper = await openRequestChanges();
    const boxes = wrapper.findAll("input[type='checkbox']");
    await boxes[0].setValue(true);
    await boxes[1].setValue(true);
    await noteBox(wrapper, "Seminar Room 3-01").setValue("Exits are blocked by the stage.");
    await sendButton(wrapper).trigger("click");

    expect(wrapper.text()).toContain("Say what must change here.");
    expect(requestSafetyChanges).not.toHaveBeenCalled();
  });

  it("AC1: sends each picked arrangement with its note, and the general note", async () => {
    requestSafetyChanges.mockResolvedValue({ id: 7, status: "Planning" });
    const wrapper = await openRequestChanges();
    await wrapper.findAll("input[type='checkbox']")[1].setValue(true);
    await noteBox(wrapper, "PA system × 2").setValue("  Move the PA away from the fire exit.  ");
    await wrapper.get('textarea[id="changes-general-7"]').setValue("Send an updated crowd plan.");
    fetchSafetyReviewQueue.mockResolvedValue([]);
    await sendButton(wrapper).trigger("click");
    await flushPromises();

    expect(requestSafetyChanges).toHaveBeenCalledWith(
      7,
      [{ type: "equipment_item", id: 51, note: "Move the PA away from the fire exit." }],
      "Send an updated crowd plan.",
    );
    expect(wrapper.text()).toContain("Changes requested for Spring Gala — back in Planning.");
  });

  it("leaves the general note out when it's empty", async () => {
    requestSafetyChanges.mockResolvedValue({ id: 7, status: "Planning" });
    const wrapper = await openRequestChanges();
    await wrapper.findAll("input[type='checkbox']")[0].setValue(true);
    await noteBox(wrapper, "Seminar Room 3-01").setValue("Exits are blocked.");
    fetchSafetyReviewQueue.mockResolvedValue([]);
    await sendButton(wrapper).trigger("click");
    await flushPromises();

    expect(requestSafetyChanges).toHaveBeenCalledWith(7, [{ type: "venue_booking", id: 32, note: "Exits are blocked." }], null);
  });
});

describe("SafetyChangesCard (AC3)", () => {
  const changeRequest: SafetyChangeRequest = {
    reviewId: 903,
    officerName: "Sam Tan",
    requestedAt: "2026-10-15T06:32:00.000Z",
    reason: "Seminar Room 3-01: Exits blocked; PA system × 2: Move it. General: Update the crowd plan.",
    generalNote: "Update the crowd plan.",
    arrangementsChecked: true,
    flags: [
      { type: "venue_booking", id: 32, label: "Seminar Room 3-01", note: "Exits blocked.", clearedAt: null },
      {
        type: "equipment_item",
        id: 51,
        label: "PA system × 2",
        note: "Move it.",
        clearedAt: "2026-10-15T08:00:00.000Z",
      },
    ],
  };

  it("shows the officer, each flag with its note and state, and the general notes", () => {
    const wrapper = mount(SafetyChangesCard, { props: { changeRequest } });
    const text = wrapper.text();

    expect(text).toContain("Sam Tan");
    expect(text).toContain("1 of 2 flagged arrangements still to change.");
    const rows = wrapper.findAll(".flag");
    expect(rows[0].text()).toContain("Seminar Room 3-01");
    expect(rows[0].text()).toContain("Exits blocked.");
    expect(rows[0].text()).toContain("Needs re-review");
    expect(rows[1].text()).toContain("Move it.");
    expect(rows[1].text()).toContain("Changed");
    expect(wrapper.get(".general").text()).toContain("Update the crowd plan.");
  });

  it("has no general notes section without one", () => {
    const wrapper = mount(SafetyChangesCard, { props: { changeRequest: { ...changeRequest, generalNote: null } } });
    expect(wrapper.find(".general").exists()).toBe(false);
  });

  it("says so once every flag has cleared", () => {
    const allDone = {
      ...changeRequest,
      flags: changeRequest.flags.map((f) => ({ ...f, clearedAt: "2026-10-15T08:00:00.000Z" })),
    };
    expect(mount(SafetyChangesCard, { props: { changeRequest: allDone } }).text()).toContain(
      "Every flagged arrangement has been changed.",
    );
  });
});
