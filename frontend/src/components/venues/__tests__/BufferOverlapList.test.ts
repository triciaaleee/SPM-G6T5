import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import BufferOverlapList from "../BufferOverlapList.vue";
import type { BufferOverlapRecord } from "../../../lib/venuesApi";

function makeOverlap(overrides: Partial<BufferOverlapRecord> = {}): BufferOverlapRecord {
  return {
    id: 1,
    detectedAt: "2026-10-10T00:00:00.000Z",
    first: { bookingId: 1, eventId: 7, eventName: "Nut Festival", window: "2026-10-12 09:30–12:45" },
    second: { bookingId: 2, eventId: 8, eventName: "Bake Sale", window: "2026-10-12 12:00–14:45" },
    ...overrides,
  };
}

function mountList(
  props: Partial<{ overlaps: BufferOverlapRecord[]; loading: boolean; loadError: string | null }> = {},
) {
  return mount(BufferOverlapList, { props: { overlaps: [], ...props } });
}

describe("BufferOverlapList", () => {
  it("AC2: shows both bookings' events and the overlap window for each flagged pair", () => {
    const wrapper = mountList({ overlaps: [makeOverlap()] });

    const cards = wrapper.findAll(".overlap-card");
    expect(cards).toHaveLength(1);
    expect(cards[0].text()).toContain("Nut Festival");
    expect(cards[0].text()).toContain("2026-10-12 09:30–12:45");
    expect(cards[0].text()).toContain("Bake Sale");
    expect(cards[0].text()).toContain("2026-10-12 12:00–14:45");
  });

  it("renders every flagged pair", () => {
    const wrapper = mountList({
      overlaps: [
        makeOverlap({ id: 1 }),
        makeOverlap({ id: 2, first: { bookingId: 3, eventId: 9, eventName: "Open Day", window: "x" } }),
      ],
    });

    expect(wrapper.findAll(".overlap-card")).toHaveLength(2);
  });

  it("falls back to 'Untitled event' when a booking's event has no name", () => {
    const wrapper = mountList({
      overlaps: [makeOverlap({ first: { bookingId: 1, eventId: 7, eventName: null, window: "x" } })],
    });

    expect(wrapper.text()).toContain("Untitled event");
  });

  it("shows an empty state when nothing is flagged", () => {
    const wrapper = mountList({ overlaps: [] });

    expect(wrapper.find(".empty-state").exists()).toBe(true);
    expect(wrapper.text()).toContain("No flagged pairs");
    expect(wrapper.findAll(".overlap-card")).toHaveLength(0);
  });

  it("shows a loading state instead of the empty state while loading", () => {
    const wrapper = mountList({ overlaps: [], loading: true });

    expect(wrapper.text()).toContain("Checking flagged bookings");
    expect(wrapper.find(".empty-state").exists()).toBe(false);
  });

  it("surfaces a load error instead of the empty state", () => {
    const wrapper = mountList({ overlaps: [], loadError: "We couldn't load this venue's flagged bookings." });

    expect(wrapper.find(".error-text").text()).toBe("We couldn't load this venue's flagged bookings.");
    expect(wrapper.find(".empty-state").exists()).toBe(false);
  });

  it("AC3: never renders a dismiss or delete action for a flagged pair", () => {
    const wrapper = mountList({ overlaps: [makeOverlap()] });

    // No interactive controls at all on a flagged pair's card — this is a
    // read-only list, unlike UnavailabilityCard.vue's Edit/Remove actions.
    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.find("a").exists()).toBe(false);
    expect(wrapper.find("[role=button]").exists()).toBe(false);
  });
});
