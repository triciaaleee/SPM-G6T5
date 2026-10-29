import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SegmentedToggle from "../SegmentedToggle.vue";

const OPTIONS = [
  { key: "calendar", label: "Calendar", testId: "view-calendar" },
  { key: "list", label: "List" },
];

describe("SegmentedToggle", () => {
  it("presses the chosen segment and only that one", () => {
    const wrapper = mount(SegmentedToggle, { props: { options: OPTIONS, modelValue: "list", ariaLabel: "Schedule view" } });
    const buttons = wrapper.findAll("button");

    expect(wrapper.get("[role='group']").attributes("aria-label")).toBe("Schedule view");
    expect(buttons.map((b) => b.attributes("aria-pressed"))).toEqual(["false", "true"]);
    expect(buttons[1].classes()).toContain("toggle-btn--active");
  });

  it("emits the clicked segment's key and carries its test id", async () => {
    const wrapper = mount(SegmentedToggle, { props: { options: OPTIONS, modelValue: "list" } });

    await wrapper.get("[data-testid='view-calendar']").trigger("click");

    expect(wrapper.emitted("update:modelValue")).toEqual([["calendar"]]);
  });
});
