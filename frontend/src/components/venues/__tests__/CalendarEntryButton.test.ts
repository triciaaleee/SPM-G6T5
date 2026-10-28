import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import CalendarEntryButton from "../CalendarEntryButton.vue";
import type { CalendarEntry } from "../../../lib/venueCalendar";

function entry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: "b1",
    kind: "booking",
    venueId: 1,
    date: "2099-06-01",
    startMin: 840,
    endMin: 1020,
    title: "Student Film Screening",
    status: "Approved",
    attendance: 80,
    startTime: "14:00",
    endTime: "17:00",
    allDay: false,
    ...overrides,
  };
}

function mountEntry(props: { entry?: CalendarEntry; colorSlot?: number; compact?: boolean; showVenue?: boolean } = {}) {
  return mount(CalendarEntryButton, {
    props: { entry: entry(), venueName: "Great Lawn", colorSlot: 0, showVenue: false, ...props },
  });
}

describe("CalendarEntryButton — status is the colour", () => {
  it.each([
    ["Approved", "entry--approved", "Approved"],
    ["On Hold", "entry--hold", "On Hold"],
    ["Requested", "entry--requested", "Requested"],
    ["Replacement Required", "entry--replace", "Replacement Required"],
  ] as const)("shows a %s booking as %s with its name on the first line", (status, cls, label) => {
    const wrapper = mountEntry({ entry: entry({ status }) });

    expect(wrapper.classes()).toContain(cls);
    expect(wrapper.find(".entry__status").text()).toBe(label);
    expect(wrapper.find(".entry__status svg").exists()).toBe(true);
    expect(wrapper.find(".entry__title").text()).toBe("Student Film Screening");
    expect(wrapper.find(".entry__meta").text()).toContain("14:00–17:00");
  });

  it("shows a block-out as a flat grey block with a lock and its reason, and no status line", () => {
    const wrapper = mountEntry({
      entry: entry({ id: "u1", kind: "block", status: undefined, title: "Cleaning", attendance: undefined, allDay: true, startTime: null, endTime: null }),
    });

    expect(wrapper.classes()).toContain("entry--block");
    expect(wrapper.find(".entry__status").exists()).toBe(false);
    expect(wrapper.find(".entry__title svg").exists()).toBe(true);
    expect(wrapper.find(".entry__title").text()).toBe("Cleaning");
    expect(wrapper.find(".entry__meta").text()).toBe("All day");
  });

  it("marks the venue with its slot, which is only the left edge", () => {
    expect(mountEntry({ colorSlot: 0 }).classes()).toContain("entry--slot-0");
    expect(mountEntry({ colorSlot: 3 }).classes()).toContain("entry--slot-3");
  });

  it("names the status in the accessible label, since the tag chip is gone", () => {
    const wrapper = mountEntry({ entry: entry({ status: "On Hold" }), showVenue: true });

    expect(wrapper.attributes("aria-label")).toBe("Student Film Screening, On Hold, 14:00–17:00, 80 guests, Great Lawn");
  });

  it("keeps compact blocks to one line: a status icon and the title, no times", () => {
    const wrapper = mountEntry({ compact: true });

    expect(wrapper.classes()).toContain("entry--compact");
    expect(wrapper.find(".entry__status").exists()).toBe(false);
    expect(wrapper.find(".entry__title svg").exists()).toBe(true);
    expect(wrapper.find(".entry__meta").exists()).toBe(false);
  });

  it("emits select when clicked", async () => {
    const wrapper = mountEntry();

    await wrapper.trigger("click");
    expect(wrapper.emitted("select")).toHaveLength(1);
  });
});
