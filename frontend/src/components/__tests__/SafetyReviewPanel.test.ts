import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SafetyReviewPanel from "../SafetyReviewPanel.vue";

const submitForSafetyReview = vi.fn();
const fetchSafetyReviews = vi.fn();

vi.mock("../../lib/eventsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/eventsApi")>();
  return {
    ...actual,
    submitForSafetyReview: (...args: unknown[]) => submitForSafetyReview(...args),
    fetchSafetyReviews: (...args: unknown[]) => fetchSafetyReviews(...args),
  };
});

const { SafetyReviewSubmitError } = await import("../../lib/eventsApi");

async function openAndFill(notes: Partial<Record<string, string>> = {}) {
  const wrapper = mount(SafetyReviewPanel, { props: { eventId: 7 } });
  await wrapper.get("button").trigger("click");
  const values = {
    equipmentPlacement: "Projector at the back",
    crowdMovement: "One-way flow",
    emergencyAccess: "East fire lane clear",
    venueRestrictions: "None known",
    ...notes,
  };
  for (const [key, value] of Object.entries(values)) {
    await wrapper.get(`#sr-${key}`).setValue(value);
  }
  return wrapper;
}

beforeEach(() => {
  submitForSafetyReview.mockReset();
  fetchSafetyReviews.mockReset();
  fetchSafetyReviews.mockResolvedValue([]);
});

describe("SafetyReviewPanel (E3-4)", () => {
  it("AC5: won't submit while a safety note is empty", async () => {
    const wrapper = await openAndFill({ crowdMovement: "   " });
    await wrapper.get("form").trigger("submit");

    expect(submitForSafetyReview).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain("Crowd movement is required.");
  });

  it("AC1: submits every note and hands the updated event to the page", async () => {
    const updated = { id: 7, status: "Safety Review" };
    submitForSafetyReview.mockResolvedValue(updated);
    const wrapper = await openAndFill();
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(submitForSafetyReview).toHaveBeenCalledWith(7, {
      equipmentPlacement: "Projector at the back",
      crowdMovement: "One-way flow",
      emergencyAccess: "East fire lane clear",
      venueRestrictions: "None known",
    });
    expect(wrapper.emitted("submitted")?.[0]).toEqual([updated]);
  });

  it("AC2/AC3: lists each outstanding booking and equipment item the backend names", async () => {
    submitForSafetyReview.mockRejectedValue(
      new SafetyReviewSubmitError("Settle these first", {}, {
        noApprovedVenue: true,
        bookings: [{ bookingId: 3, venueName: "Innovation Hub", status: "On Hold" }],
        equipment: [{ requestId: 9, equipmentType: "Projector", quantity: 2, quantityReserved: 1 }],
      }),
    );
    const wrapper = await openAndFill();
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain("This event has no approved venue booking.");
    expect(text).toContain("Innovation Hub is still On Hold.");
    expect(text).toContain("Projector: 1 of 2 reserved.");
    expect(wrapper.emitted("submitted")).toBeUndefined();
  });

  it("shows any other refusal as a message", async () => {
    submitForSafetyReview.mockRejectedValue(
      new SafetyReviewSubmitError("Only an event in Planning can be submitted for safety review"),
    );
    const wrapper = await openAndFill();
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(wrapper.text()).toContain("Only an event in Planning can be submitted for safety review");
  });
});

describe("SafetyReviewPanel — the last safety decision (E3-13)", () => {
  function decision(outcome: string, reason: string | null, createdAt: string) {
    return { id: createdAt.length, outcome, reason, submission_id: 1, officer: { name: "Sam Safety" }, created_at: createdAt };
  }

  async function mountPanel() {
    const wrapper = mount(SafetyReviewPanel, { props: { eventId: 7 } });
    await flushPromises();
    return wrapper;
  }

  it("AC1: shows the latest rejection's reason and who made it", async () => {
    fetchSafetyReviews.mockResolvedValue([decision("Rejected", "Fire exit blocked by staging", "2026-10-01T02:00:00Z")]);
    const wrapper = await mountPanel();

    const callout = wrapper.get('[data-testid="safety-decision"]');
    expect(fetchSafetyReviews).toHaveBeenCalledWith(7);
    expect(callout.text()).toContain("The Safety Officer rejected the last safety review");
    expect(callout.text()).toContain("Fire exit blocked by staging");
    expect(callout.text()).toContain("Sam Safety");
  });

  it("shows only the most recent decision", async () => {
    fetchSafetyReviews.mockResolvedValue([
      decision("Rejected", "Old reason", "2026-10-01T02:00:00Z"),
      decision("Rejected", "New reason", "2026-10-05T02:00:00Z"),
    ]);
    const wrapper = await mountPanel();

    const text = wrapper.get('[data-testid="safety-decision"]').text();
    expect(text).toContain("New reason");
    expect(text).not.toContain("Old reason");
  });

  it("shows nothing when the latest decision was an approval", async () => {
    fetchSafetyReviews.mockResolvedValue([
      decision("Rejected", "Old reason", "2026-10-01T02:00:00Z"),
      decision("Approved", null, "2026-10-05T02:00:00Z"),
    ]);
    const wrapper = await mountPanel();

    expect(wrapper.find('[data-testid="safety-decision"]').exists()).toBe(false);
  });

  it("shows nothing when the event has never been reviewed", async () => {
    const wrapper = await mountPanel();
    expect(wrapper.find('[data-testid="safety-decision"]').exists()).toBe(false);
  });

  it("still lets the coordinator submit when the decisions can't be loaded", async () => {
    fetchSafetyReviews.mockRejectedValue(new Error("Failed to load safety reviews"));
    const wrapper = await mountPanel();

    expect(wrapper.find('[data-testid="safety-decision"]').exists()).toBe(false);
    expect(wrapper.get("button").text()).toBe("Submit for safety review");
  });
});
