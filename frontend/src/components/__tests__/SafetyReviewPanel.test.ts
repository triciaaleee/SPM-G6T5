import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SafetyReviewPanel from "../SafetyReviewPanel.vue";
import type { EquipmentRequest } from "../../lib/equipmentApi";
import type { EventVenueBooking } from "../../lib/venuesApi";

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

/** One approved venue and no equipment: everything settled, so Submit is enabled. */
const READY: { venueBookings: EventVenueBooking[]; equipmentRequests: EquipmentRequest[] } = {
  venueBookings: [
    { id: 1, status: "Approved", holdExpiresAt: null, decisionReason: null, createdAt: "2026-10-07T02:00:00Z", venue: null },
  ],
  equipmentRequests: [],
};

function booking(status: string, id: number) {
  return { id, status, holdExpiresAt: null, decisionReason: null, createdAt: "2026-10-07T02:00:00Z", venue: null };
}

function equipmentRequest(items: { quantity: number; quantityFulfilled: number }[]) {
  return {
    id: 1,
    eventId: 7,
    status: "Requested",
    fulfillmentNote: null,
    createdAt: "2026-10-07T02:00:00Z",
    items: items.map((item, index) => ({
      id: index + 1,
      equipmentType: "Projector",
      reservationFlag: { flagged: false, reason: null },
      ...item,
    })),
  };
}

async function openAndFill(notes: Partial<Record<string, string>> = {}) {
  const wrapper = mount(SafetyReviewPanel, { props: { eventId: 7, ...READY } });
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
    const wrapper = mount(SafetyReviewPanel, { props: { eventId: 7, ...READY } });
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

describe("SafetyReviewPanel — readiness checklist", () => {
  function mountWith(props: Record<string, unknown>) {
    return mount(SafetyReviewPanel, { props: { eventId: 7, ...props } });
  }

  it("shows each arrangement with its caption and a Pending / Done badge", async () => {
    const wrapper = mountWith({
      venueBookings: [booking("Approved", 1), booking("Requested", 2), booking("Requested", 3)],
      equipmentRequests: [equipmentRequest([{ quantity: 1, quantityFulfilled: 1 }, { quantity: 2, quantityFulfilled: 2 }, { quantity: 3, quantityFulfilled: 3 }])],
    });
    await flushPromises();

    const venues = wrapper.get('[data-testid="check-venues"]');
    expect(venues.text()).toContain("Venues approved");
    expect(venues.text()).toContain("1 of 3 approved, 2 awaiting Venue Staff");
    expect(venues.text()).toContain("Pending");

    const equipment = wrapper.get('[data-testid="check-equipment"]');
    expect(equipment.text()).toContain("Equipment reserved");
    expect(equipment.text()).toContain("All 3 requested items arranged");
    expect(equipment.text()).toContain("Done");
  });

  it("shows Equipment as Pending, not Done, when equipment was asked for but none is recorded", async () => {
    const wrapper = mountWith({
      venueBookings: [booking("Approved", 1)],
      equipmentRequests: [],
      equipmentRequirements: "123 Chairs, 20 Tables",
    });
    await flushPromises();

    const equipment = wrapper.get('[data-testid="check-equipment"]');
    expect(equipment.text()).toContain("Equipment requested, not arranged yet");
    expect(equipment.text()).toContain("Pending");
    expect(wrapper.get("button").attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="submit-note"]').text()).toBe("Available once all requested equipment is reserved.");
  });

  it("shows Equipment as Done, 'No equipment requested', when the requirements say NA", async () => {
    const wrapper = mountWith({
      venueBookings: [booking("Approved", 1)],
      equipmentRequests: [],
      equipmentRequirements: "NA",
    });
    await flushPromises();

    const equipment = wrapper.get('[data-testid="check-equipment"]');
    expect(equipment.text()).toContain("No equipment requested");
    expect(equipment.text()).toContain("Done");
  });

  it("disables Submit, and says why, until every venue is approved", async () => {
    const wrapper = mountWith({
      venueBookings: [booking("Approved", 1), booking("Requested", 2)],
      equipmentRequests: [],
    });
    await flushPromises();

    expect(wrapper.get("button").attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="submit-note"]').text()).toBe("Available once all venues are approved.");
  });

  it("shows Needs action, and what to resolve, when a reserved item is unavailable", async () => {
    const flagged = {
      ...equipmentRequest([{ quantity: 1, quantityFulfilled: 1 }]).items[0],
      equipmentType: "Chair",
      reservationFlag: { flagged: true, reason: "Damaged" },
    };
    const wrapper = mountWith({
      venueBookings: [booking("Approved", 1)],
      equipmentRequests: [{ ...equipmentRequest([]), items: [flagged] }],
    });
    await flushPromises();

    const equipment = wrapper.get('[data-testid="check-equipment"]');
    expect(equipment.text()).toContain("Needs action");
    expect(equipment.text()).toContain("A reserved chair is unavailable.");
    expect(wrapper.get("button").attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="submit-note"]').text()).toBe("Resolve the equipment issue to submit.");
  });

  it("disables Submit, and says why, while equipment is still to be reserved", async () => {
    const wrapper = mountWith({
      venueBookings: [booking("Approved", 1)],
      equipmentRequests: [equipmentRequest([{ quantity: 2, quantityFulfilled: 1 }])],
    });
    await flushPromises();

    expect(wrapper.get("button").attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="submit-note"]').text()).toContain("Available once all requested equipment is reserved.");
  });

  it("enables Submit once everything is settled, and opens the notes form", async () => {
    const wrapper = mountWith({ ...READY });
    await flushPromises();

    expect(wrapper.get("button").attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-testid="submit-note"]').text()).toBe("The event can't be edited while it is under review.");
    await wrapper.get("button").trigger("click");
    expect(wrapper.find("form").exists()).toBe(true);
  });

  it("keeps Submit disabled while the arrangements are still loading", async () => {
    const wrapper = mountWith({});
    await flushPromises();

    expect(wrapper.get("button").attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="check-venues"]').text()).toContain("Checking…");
  });

  it("is read-only for anyone who can't submit: checklist only, no button, no decision lookup", async () => {
    fetchSafetyReviews.mockClear();
    const wrapper = mountWith({ ...READY, canSubmit: false });
    await flushPromises();

    expect(wrapper.find('[data-testid="safety-checklist"]').exists()).toBe(true);
    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.find('[data-testid="submit-note"]').exists()).toBe(false);
    expect(fetchSafetyReviews).not.toHaveBeenCalled();
  });
});
